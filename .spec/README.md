# 開発・運用管理（Spec 駆動開発と CI/CD）

このディレクトリはプロジェクトの仕様と開発プロセスを管理する。デプロイと利用の手順はリポジトリ直下の [README.md](../README.md) を参照。

## ファイルの役割

| ファイル | 内容 | 誰が編集するか |
|----------|------|----------------|
| `constitution.md` | 憲法。AWS 前提・サーバレス優先・TDD・ブランチ運用の原則 | 人間のみ。エージェントは読むだけ |
| `specify.md` | 上位ビジョン（課題・利用者・スコープ・成功の定義） | `/sdd init` |
| `requirements.md` | EARS 構文の要件（REQ-xxx / NFR-xxx）と受け入れ基準 | `/sdd init` |
| `design.md` | 技術仕様（構成・データモデル・API・コスト・テスト戦略・トレーサビリティ） | `/sdd init`、ADR に伴う更新 |
| `task.md` | 実装計画。`/sdd develop` が上から順に実行し、完了ログを追記する | `/sdd init` / `/sdd develop` |
| `adr/NNNN-<slug>.md` | Architecture Decision Record。重大な技術判断と憲法からの例外 | 設計判断のたびに起票 |
| `templates/` | 各文書と知見の雛形。`{{}}` プレースホルダを埋めて使う | `/sdd upgrade` |
| `../.learn/` | 実装中に得た知見（1 件 1 ファイル）と `CHANGELOG.md` | `/sdd learn` / `/sdd upgrade` |

## 開発プロセス

Claude Code の `/sdd` スキル（`.claude/skills/sdd/`）で進める。

| コマンド | 用途 |
|----------|------|
| `/sdd init <開発要望>` | 憲法に従って spec 一式を対話的に作成する。既存の spec があれば「更新か再作成か」を確認するので、機能追加は「更新」で差分を積む |
| `/sdd develop [T-xxx]` | `task.md` の未完了タスクを TDD（Red → Green → Refactor）で実装する。設計から外れる場合は ADR を起票して承認を得る |
| `/sdd learn <知見>` | 実装中の発見を `.learn/` に記録する |
| `/sdd upgrade` | 溜まった知見をレビューし、CLAUDE.md・手順書・テンプレートへ昇格する。憲法への反映は人間が行う |

規律の要点:

- すべての実装はテストを先に書き、失敗を確認してから通す。テストのない振る舞いは追加しない。
- spec に無い振る舞いは実装しない。必要なら requirements / design を先に更新する。
- 憲法と矛盾する判断、コンピュート・データストア・認証方式の変更、データモデルの変更は ADR にする（番号は既存の最大値 + 1）。ADR を起票したら design.md と task.md を同期する。
- 知見は安価に記録し、昇格は `/sdd upgrade` で慎重に行う。`status: new` が 5 件以上溜まったら昇格を検討する。
- Claude Code の自動モードでは AWS への適用コマンド（`cdk deploy` 等）が分類器に止まることがある。`.claude/settings.json` の `permissions.allow` に必要なコマンドを登録してある（L-0012）。

## ブランチと CI/CD

```
PR → ci.yml            ユニットテスト + cdk synth（AWS 不要）
push develop → deploy-dev.yml
    deploy:  npm run build → npm test → OIDC で dev ロール → cdk deploy (stage=dev) → 正常性テスト
    promote: テスト済み SHA を main へ fast-forward → deploy-prod.yml を起動
main → deploy-prod.yml   OIDC で prod ロール → cdk deploy (stage=prod) → 正常性テスト
```

- 人間は `main` に直接 push しない。`main` には正常性テストを通過した commit だけが入る。
- 文書だけの変更でも `develop` への push で dev / prod のデプロイが 1 周する（インフラ差分が無ければ数分で終わる）。
- ワークフローが依存する契約: `npm test`、`npm run build`（`dist/mcp/main.js`。MCP コンテナの Dockerfile が参照）、`npm run test:smoke`（`CDK_OUTPUTS_FILE` と `STAGE` を読む）、`npx cdk deploy --all --context stage=<dev|prod>`。詳細と落とし穴は [.github/workflows/README.md](../.github/workflows/README.md)。

| stage | AWS アカウント | トリガ | 昇格条件 |
|-------|----------------|--------|----------|
| dev | dev アカウント（Repository variable `AWS_DEV_ROLE_ARN`） | `develop` への push | 正常性テスト通過で `main` へ fast-forward |
| prod | prod アカウント（Repository variable `AWS_PROD_ROLE_ARN`） | `main` 更新（promote ジョブが `workflow_dispatch` で起動） | なし（個人利用。必要なら Environment `production` に Required reviewers を後付け） |

## アカウントの初回セットアップ（CI/CD 用、アカウントごとに 1 回）

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

# 3. ロール ARN を Repository variables に設定（スタック出力 RoleArn）
gh variable set AWS_DEV_ROLE_ARN  --body "arn:aws:iam::<dev account>:role/github-deploy-dev"
gh variable set AWS_PROD_ROLE_ARN --body "arn:aws:iam::<prod account>:role/github-deploy-production"
```

- デプロイロールの信頼ポリシーは、GitHub の OIDC トークンの `sub` が `environment:<name>` 形式になること、および owner / repo の数値 ID 付き形式（`repo:<owner>@<id>/<repo>@<id>:...`）で発行されることの両方を許可している（L-0011）。
- デプロイロールは CDK ブートストラップロールの引受けに加え、AgentCore のサービスリンクロール作成と、正常性テストが読む `mail-mcp/*/smoke-user*` シークレットの取得を許可している。
- Environment `dev` / `production` はワークフローが参照した時点で GitHub が自動作成する。
- 同一アカウントに dev / prod の両ロールを作る場合は、テンプレートが `AWS::IAM::OIDCProvider` を作るため 2 回目の `deploy` が衝突する。スタック名を変え、2 つ目はプロバイダ作成を外す（または既存プロバイダの ARN を参照する）修正が必要。

## 正常性テスト（`npm run test:smoke`）

デプロイ後の環境に対して次を実行し、応答時間も検証する（NFR-005 / NFR-006）。実メールボックスは変更しない。

- 無トークンの `POST /mcp` が 401 と façade の Protected Resource Metadata を指す `WWW-Authenticate` を返す
- well-known 2 本が 200 で、PKCE（S256）を広告している
- `initialize` / `tools/list` が 13 ツールを返す
- `list_folders` → `search_messages` → `get_message`（同期済みメールが 0 件なら検索の空応答までで合格）
- `schedule_message`（11 か月後、宛先 `smoke-test@example.invalid`）→ `list_scheduled_messages` に pending → `cancel_scheduled_message`

認証は CDK が作る Cognito ユーザ `smoke`（パスワードは Secrets Manager `mail-mcp/<stage>/smoke-user-password`）の `USER_PASSWORD_AUTH`。

## 手元からの直接デプロイ

CI/CD を通さずにデプロイする手順（初回構築や緊急時）は [README.md](../README.md) の「デプロイ」を参照。dev スタックは CI/CD と共有なので、直接デプロイした変更は `develop` にも取り込むこと。
