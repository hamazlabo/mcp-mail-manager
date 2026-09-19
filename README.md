# mcp-mail-manager

AI エージェント（Claude Desktop / claude.ai / Claude Code などの MCP クライアント）から、自分の IMAP / SMTP メールボックスを
検索・閲覧・送信・返信・転送・整理・予約送信できるようにする、AWS 上のリモート MCP サーバです。
メールサーバのパスワードは AWS Secrets Manager にだけ置き、エージェントには渡しません。

開発プロセス（Spec 駆動開発）と CI/CD の管理は [.spec/README.md](.spec/README.md) を参照してください。

## できること

| 分類 | ツール | 内容 |
|------|--------|------|
| 閲覧 | `list_folders` `search_messages` `get_message` | フォルダ一覧、条件検索（フォルダ・差出人・宛先・件名・期間・未読・フラグ）、本文の取得 |
| 送信 | `send_message` `reply_message` `forward_message` | プレーンテキストの新規送信、スレッドを維持した返信、転送。送ったメールは Sent にも残る |
| 整理 | `set_read` `set_flagged` `move_message` `trash_message` | 既読/未読、フラグ、フォルダ移動、ゴミ箱へ移動（完全削除はしない） |
| 予約 | `schedule_message` `list_scheduled_messages` `cancel_scheduled_message` | 指定日時（最大 1 年先）に 1 通を 1 回だけ送る。一覧と取消 |

## 仕組み

| 役割 | 実体 |
|------|------|
| MCP サーバ | Amazon Bedrock AgentCore Runtime 上のコンテナ（`src/mcp`）。OAuth 2.1 のトークンを AgentCore が検証する |
| 入口 | CloudFront（`https://<配布ドメイン>/mcp`）。OAuth のディスカバリ（well-known）と認証前チェックを CloudFront Function が担う |
| 認証 | Amazon Cognito User Pool（Managed Login）。利用者は自分（と正常性テスト用の `smoke` ユーザ）だけ、セルフサインアップ無効 |
| 同期 | Lambda が 15 分ごとに IMAP から新着を取り込み、生メッセージを S3、メタ情報を DynamoDB に保存（検索は DynamoDB） |
| 予約送信 | EventBridge Scheduler の一回限りスケジュールで Lambda を起動し、DynamoDB の条件付き更新で二重送信を防ぐ |
| 設定 | Secrets Manager `mail-mcp/<stage>/mail`（IMAP / SMTP の認証情報） |

保持期間: 同期したメールは受信日から 1 年、予約レコードは完了から 90 日で自動削除。常時起動のリソースは持たず、利用がない月のコストは 1 USD 未満です。

## 前提

- Node.js 22、AWS CLI v2（対象アカウントのプロファイルを設定済み）
- AWS アカウント（`ap-northeast-1`）。dev / prod の 2 段構成を想定するが、スタック名は `MailMcp-<stage>` で分かれるので 1 アカウントでも動く（CI/CD の OIDC ロールを同一アカウントに 2 つ作る場合は `.spec/README.md` の注意を参照）
- メールサーバが IMAP（993 / TLS）と SMTP（587 STARTTLS または 465）でパスワード認証できること。さくらのメールボックスで動作確認済み
- Docker はローカルでコンテナを試すときだけ必要（ARM64 イメージはデプロイ時に AWS 側の CodeBuild がビルドする）

## デプロイ

```sh
npm ci
npm run build                                                        # dist/mcp/main.js（コンテナが使う）
npx cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-1 --profile <profile> --context stage=<dev|prod>   # アカウントごとに 1 回
npx cdk deploy --all --context stage=<dev|prod> --profile <profile> --outputs-file cdk-outputs.json
```

初回は CodeBuild でのイメージビルドと CloudFront の作成で 10〜15 分かかります。完了すると `cdk-outputs.json` に次の出力が入ります。

| 出力 | 用途 |
|------|------|
| `McpUrl` | Claude に登録する URL（`https://<配布ドメイン>/mcp`） |
| `UserPoolClientId` | Claude に登録する OAuth クライアント ID |
| `UserPoolId` / `CognitoDomain` | 自分のユーザ作成、ログイン画面のドメイン |
| `MailSecretArn` / `TableName` / `BucketName` | 設定と保存先 |

アラーム通知の宛先は `cdk.json` の context `alarmEmail`（`--context alarmEmail=you@example.net` で上書き可）。

## デプロイ後の設定（1 回だけ）

### 1. メールサーバの認証情報を入れる

Secrets Manager `mail-mcp/<stage>/mail` の値を JSON で上書きします。必須は 3 項目です。

```sh
aws secretsmanager put-secret-value --profile <profile> --secret-id mail-mcp/<stage>/mail \
  --secret-string '{"domain":"example.net","user":"someone","password":"..."}'
```

| キー | 必須 | 既定値 / 導出 |
|------|------|---------------|
| `domain` | 必須 | メールアドレスのドメイン。ログイン名 `<user>@<domain>` と From アドレスに使う |
| `user` | 必須 | メールアドレスのローカル部 |
| `password` | 必須 | IMAP / SMTP 共通 |
| `imapHost` / `smtpHost` | 任意 | 省略時は `domain` の MX レコードのうち優先度最小のホスト（さくら: `<初期ドメイン>.sakura.ne.jp`）。MX と IMAP ホストが違うプロバイダでは指定する |
| `imapPort` / `smtpPort` / `smtpSecure` | 任意 | `993` / `587` / `false`（STARTTLS）。465 を使うなら `smtpPort: 465, smtpSecure: true` |
| `fromName` | 任意 | From の表示名 |
| `sentFolder` / `trashFolder` | 任意 | `INBOX.Sent` / `INBOX.Trash`。サーバが SPECIAL-USE 属性を持つ場合はそちらを優先 |

15 分以内に同期が始まり、過去 90 日分のメールが検索できるようになります（件数が多いと複数回に分けて取り込みます）。

### 2. 自分の Cognito ユーザを作る

```sh
aws cognito-idp admin-create-user --profile <profile> --user-pool-id <UserPoolId> \
  --username developer \
  --user-attributes Name=email,Value=<あなたのメールアドレス> Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

- `--username` にメールアドレス形式は使えません（email はエイリアスとして登録され、ログイン時はどちらでも可）。
- Cognito から「Your temporary password」という招待メールが届きます。初回ログインで本パスワードを設定します。仮パスワードは 7 日で失効し、`--message-action RESEND` で再送できます。
- この招待メールは HTML パートしか無いため、HTML を表示しないウェブメールでは本文が空に見えます。「HTML で表示」か「ソースを表示」で読んでください。

### 3. アラーム通知の購読を確認する

初回デプロイ後に "AWS Notification - Subscription Confirmation" というメールが届くので、確認リンクを開きます。予約送信が失敗したときに通知が届くようになります。

## Claude に登録する

Claude Desktop / claude.ai（設定 → コネクタ → カスタムコネクタを追加）:

| 項目 | 値 |
|------|----|
| リモート MCP サーバー URL | `McpUrl` |
| OAuth クライアント ID | `UserPoolClientId` |
| OAuth クライアントシークレット | 空欄 |

Claude Code:

```sh
claude mcp add --transport http --client-id <UserPoolClientId> --callback-port 8765 mail <McpUrl>
```

いずれもブラウザで Cognito のログイン画面が開き、完了すると `list_folders` などが使えます。コールバック URL（`https://claude.ai/api/mcp/auth_callback` と `http://localhost:8765/callback`）は登録済みです。

## 使い方

自然言語で頼めば Claude がツールを選びます。例:

- 「受信トレイの最新 5 件を表にして、1 件目を要約して」
- 「A さんからの先週のメールを探して、要点をまとめて返信して」
- 「このメールを contact@example.net に『ご確認ください』と添えて転送して」
- 「件名『請求書』のメールに フラグを付けて、INBOX.Archive に移動して」
- 「明日 9 時に B さんへ『本日の打合せについて』を送るよう予約して」「予約一覧を出して」「取り消して」

知っておくこと:

- 検索・閲覧は 15 分ごとの同期データに対して動きます。届いたばかりのメールや、いま整理したメールの状態は次の同期まで反映されません。`list_folders` の件数は同期時点（`lastSyncAt`）の値です。
- 送信メールはプレーンテキストのみ。受信した HTML メールはテキスト化して返します。添付ファイルはファイル名・種別・サイズだけ分かり、本体の取得・送信は未対応です。
- 削除は「ゴミ箱へ移動」だけです。サーバによっては移動元に削除マーク付きのコピーが残り、メールソフトの整理（expunge）で消えます。
- `move_message` / `trash_message` の後はメッセージの id が変わります。Claude は応答の新しい id を使います。
- 自分宛に送ったメールは INBOX と Sent の両方に別のメッセージとして現れます。
- 予約送信は指定時刻から数分以内に 1 回だけ送られ、`list_scheduled_messages` の状態が `sent` になります。失敗すると合計 3 回まで試行し（初回 + 再試行 2 回）、それでも失敗すると `failed` になって理由が一覧に残り、アラームメールが届きます。送信結果が確認できない場合は再送せず `failed`（`unknown-delivery`）にします。

## 動作確認とテスト

```sh
npm test                      # ユニットテスト（AWS 不要）
STAGE=dev CDK_OUTPUTS_FILE=cdk-outputs.json AWS_PROFILE=<profile> npm run test:smoke   # デプロイ済み環境の正常性テスト（実メールは送らない）

# コンテナをローカルで動かす（ホストのアーキテクチャでビルド）
npm run build && docker build -f docker/Dockerfile -t mail-mcp .
docker run --rm -p 8000:8000 -e STAGE=local -e TABLE_NAME=<TableName> -e BUCKET_NAME=<BucketName> \
  -e MAIL_SECRET_ARN=<MailSecretArn> -e SCHEDULE_GROUP=mail-mcp-dev -e SCHEDULER_ROLE_ARN=arn:aws:iam::0:role/x \
  -e SCHEDULED_SEND_FUNCTION_ARN=arn:aws:lambda:ap-northeast-1:0:function:x -e AWS_REGION=ap-northeast-1 \
  -v ~/.aws:/home/node/.aws:ro -e AWS_PROFILE=<profile> mail-mcp   # ツール実行には AWS 資格情報が必要（/ping と tools/list だけなら不要）
npx @modelcontextprotocol/inspector   # Streamable HTTP で http://localhost:8000/mcp に接続
```

## コストの目安

想定利用（受信 100 通/日、ツール呼出 200 回/日、予約 10 通/日、同期 15 分間隔）で月額約 2 USD、利用がない月は約 0.9 USD（Secrets Manager、ECR、ログ保持）。内訳は `.spec/design.md` 8 章。

## トラブルシューティング

| 症状 | 確認すること |
|------|--------------|
| Claude でログインは通るのに「認証に失敗しました」 | Cognito の User Pool に `McpUrl` を識別子とするリソースサーバがあるか（CDK が作る。無いとトークン交換が `invalid_grant` になる）。CloudTrail の `Token_POST` に 400 が出る |
| 招待メールの本文が空 | HTML のみのメール。ウェブメールで HTML 表示に切り替える |
| 送ったメールが検索に出ない | 同期は 15 分ごと。`list_folders` の `lastSyncAt` を確認する |
| 予約が `failed` | `list_scheduled_messages` の `error` を見る。`unknown-delivery` は送信結果が確認できなかった状態で、Sent フォルダを確認してから必要なら送り直す |
| 移動先フォルダのエラー | フォルダ名は IMAP の完全名（さくらは `INBOX.spam` のように `INBOX.` 付き） |

ログ（CloudWatch Logs）には本文・認証情報・トークンを出しません。同期 Lambda のログ `sync.reconcile` の `known` と `total` が食い違う場合は、同期データを作り直すと揃います。

## 削除

```sh
npx cdk destroy --context stage=<dev|prod> --profile <profile>
```

prod ではデータ（DynamoDB テーブル、S3 バケット、Cognito User Pool）を保持する設定なので、不要なら手動で削除してください。
