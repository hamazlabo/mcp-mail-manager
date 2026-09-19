# mcp-mail-manager

AI エージェント（Claude Code / Claude Desktop など MCP クライアント）が、個人の IMAP / SMTP メールボックスを
検索・閲覧・送信・返信・整理・予約送信できるようにする、AWS 上のリモート MCP サーバ。

- 受信メールは 15 分ごとに IMAP から同期し、生メッセージを S3、メタ情報を DynamoDB に保管する（検索は DynamoDB）
- MCP サーバは Amazon Bedrock AgentCore Runtime 上のコンテナ。前段の CloudFront が OAuth ディスカバリを提供する
- 認証は OAuth 2.1（Amazon Cognito）。IMAP / SMTP の認証情報は Secrets Manager にだけ置く
- 予約送信は EventBridge Scheduler の一回限りスケジュールで、ちょうど 1 回だけ送る

仕様は `.spec/`（specify → requirements → design → task → adr）にある。憲法は `.spec/constitution.md`。

## 構成

| 役割 | 実体 |
|------|------|
| MCP サーバ | AgentCore Runtime（ARM64 コンテナ、`src/mcp`）。ツール 13 本 |
| façade | CloudFront + CloudFront Functions（`infra/functions`）。`/.well-known/*` と `/mcp` |
| 同期 | Lambda `mail-mcp-<stage>-sync`（15 分間隔、`src/sync`） |
| 予約送信 | Lambda `mail-mcp-<stage>-scheduled-send`（Scheduler から起動、`src/scheduled-send`） |
| データ | DynamoDB `MailTable-<stage>`、S3 `mail-mcp-raw-<stage>-<account>`（保持 1 年） |
| 認証 | Cognito User Pool + Managed Login、AgentCore の JWT 認可 |
| 設定 | Secrets Manager `mail-mcp/<stage>/mail`（IMAP / SMTP）、`mail-mcp/<stage>/smoke-user`（正常性テスト） |

MCP ツール: `list_folders` `search_messages` `get_message` `send_message` `reply_message` `forward_message`
`set_read` `set_flagged` `move_message` `trash_message` `schedule_message` `list_scheduled_messages` `cancel_scheduled_message`

## 前提

- Node.js 22、AWS CLI v2、`gh`（GitHub CLI）。Docker はローカル動作確認にだけ使う（ARM64 イメージはデプロイ時に CodeBuild がビルドする）
- AWS アカウント 2 つ（dev / prod）と、それぞれの CLI プロファイル
- メールサーバは IMAP（993 / TLS）と SMTP（587 STARTTLS または 465）でパスワード認証できること

## 初回セットアップ（アカウントごとに 1 回）

```sh
npm ci

# 1. CDK ブートストラップ
npx cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-1 --profile <profile> --context stage=<dev|prod>

# 2. GitHub Actions 用の OIDC プロバイダとデプロイロール（dev は develop ブランチ、prod は main）
aws cloudformation deploy --profile <dev profile> --template-file infra/bootstrap/github-oidc.yaml \
  --stack-name github-oidc-deploy --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides Branch=develop EnvironmentName=dev
aws cloudformation deploy --profile <prod profile> --template-file infra/bootstrap/github-oidc.yaml \
  --stack-name github-oidc-deploy --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides Branch=main EnvironmentName=production

# 3. ロール ARN を Repository variables に設定（出力 RoleArn）
gh variable set AWS_DEV_ROLE_ARN  --body "arn:aws:iam::<dev account>:role/github-deploy-dev"
gh variable set AWS_PROD_ROLE_ARN --body "arn:aws:iam::<prod account>:role/github-deploy-production"
```

CI/CD の詳細は `.github/workflows/README.md`。`develop` への push で dev にデプロイし、正常性テストを通過した commit だけが `main` に昇格して prod にデプロイされる。

## デプロイ

CI/CD 経由が基本。手元から直接デプロイする場合:

```sh
npm run build                                   # dist/mcp/main.js（Dockerfile が参照する）
npx cdk deploy --all --context stage=dev --profile <dev profile> --outputs-file cdk-outputs.json
```

初回は CodeBuild での ARM64 イメージビルドと CloudFront の作成で 10 分前後かかる。

CDK Outputs（`cdk-outputs.json` の `MailMcp-<stage>`）:
`McpUrl` `AgentRuntimeArn` `UserPoolId` `UserPoolClientId` `CognitoDomain` `SmokeUserSecretArn` `MailSecretArn` `TableName` `BucketName`

## デプロイ後に 1 回だけ行うこと

### 1. メールサーバの認証情報を Secrets Manager に入れる

`mail-mcp/<stage>/mail` の値を JSON で上書きする。必須は 3 項目のみ。

```sh
aws secretsmanager put-secret-value --profile <profile> --secret-id mail-mcp/<stage>/mail \
  --secret-string '{"domain":"example.net","user":"someone","password":"..."}'
```

| キー | 必須 | 既定値 / 導出 |
|------|------|---------------|
| `domain` | 必須 | カスタムドメイン。MX 導出・ログイン名・From に使う |
| `user` | 必須 | メールアドレスのローカル部。ログイン名は `<user>@<domain>`（さくらはメールアドレス全体でログイン） |
| `password` | 必須 | IMAP / SMTP 共通 |
| `imapHost` / `smtpHost` | 任意 | 省略時は `domain` の MX のうち優先度最小のホスト（さくら: `<初期ドメイン>.sakura.ne.jp`） |
| `imapPort` / `smtpPort` / `smtpSecure` | 任意 | `993` / `587` / `false`（STARTTLS） |
| `fromName` | 任意 | 表示名 |
| `sentFolder` / `trashFolder` | 任意 | `INBOX.Sent` / `INBOX.Trash`（SPECIAL-USE 対応サーバでは属性を優先） |

15 分以内に同期 Lambda が動き、過去 90 日分のメールが DynamoDB / S3 に入る（初回は複数回に分けて取り込む）。

### 2. Cognito に自分のユーザを作る

```sh
aws cognito-idp admin-create-user --profile <profile> --user-pool-id <UserPoolId> \
  --username <あなたのメールアドレス> \
  --user-attributes Name=email,Value=<あなたのメールアドレス> Name=email_verified,Value=true
```

Cognito から仮パスワードの招待メールが届く。初回ログイン時に本パスワードを設定する。セルフサインアップは無効。

### 3. Claude に登録する

Claude Code:

```sh
claude mcp add --transport http --client-id <UserPoolClientId> --callback-port 8765 mail <McpUrl>
```

ブラウザで Cognito のログイン画面が開く。完了後、Claude Code で `list_folders` などが使える。

Claude Desktop / claude.ai: 設定 → コネクタ → カスタムコネクタを追加。URL に `<McpUrl>`、OAuth の Client ID に `<UserPoolClientId>`（シークレットなし）を入れる。

### 4. アラーム通知メールの購読を確認する

予約送信が `failed` になると SNS からメールが届く。宛先は `cdk.json` の context `alarmEmail`（`--context alarmEmail=...` で上書き可）。
初回デプロイ後に "AWS Notification - Subscription Confirmation" メールの確認リンクを開く。

## ローカル開発

```sh
npm test                      # ユニットテスト（AWS 不要）
npm run typecheck
npm run build                 # dist/mcp/main.js
node dist/mcp/main.js         # 0.0.0.0:8000（環境変数 TABLE_NAME 等が必要。AWS 資格情報は実行環境のもの）

# コンテナ（ホストのアーキテクチャでビルド。ARM64 はデプロイ時に CodeBuild が作る）
docker build -f docker/Dockerfile -t mail-mcp .
docker run --rm -p 8000:8000 -e STAGE=local -e TABLE_NAME=... -e BUCKET_NAME=... -e MAIL_SECRET_ARN=... \
  -e SCHEDULE_GROUP=... -e SCHEDULER_ROLE_ARN=... -e SCHEDULED_SEND_FUNCTION_ARN=... mail-mcp
npx @modelcontextprotocol/inspector   # Streamable HTTP で http://localhost:8000/mcp に接続
```

正常性テスト（デプロイ済み環境に対して。認証・well-known・tools/list・閲覧・予約の作成と取消。実メールは送らない）:

```sh
STAGE=dev CDK_OUTPUTS_FILE=cdk-outputs.json AWS_PROFILE=<dev profile> npm run test:smoke
```

## コストの目安

想定利用（受信 100 通/日、ツール呼出 200 回/日、予約 10 通/日、同期 15 分間隔）で月額約 2 USD、
利用がない月は約 0.9 USD（Secrets Manager 2 本 + ECR + ログ保持）。常時起動のリソースは持たない。内訳は `.spec/design.md` 8 章。

## 運用メモ

- 削除は「ゴミ箱へ移動」だけで、EXPUNGE は発行しない（コードベースに存在しないことを静的テストで検証）
- 同期は一方向（IMAP → AWS）。整理操作は IMAP を先に更新し、成功後に DynamoDB を更新する
- 予約送信は `pending → sending → sent | failed` を DynamoDB の条件付き更新で遷移させ、二重送信しない。送信結果が不明な場合は再送せず `failed(unknown-delivery)` にしてアラームで知らせる
- ログには本文・認証情報・トークンを出さない
