# Tasks: mcp-mail-manager

> design.md を AI エージェントが 1 タスクずつ実行できる粒度に分解した実装計画。
> `/sdd develop` はこのファイルの未完了タスクを上から順に実行する。
> すべてのタスクは TDD（Red → Green → Refactor）で進める。

## 進め方の規約

- タスク ID は `T-001` 形式。依存関係は ID で示す。
- 1 タスク = 1 つの検証可能な成果。目安は変更 300 行以内、テスト 1〜5 本。
- タスク完了時にチェックボックスを `[x]` にし、完了日を記入する。
- 設計から外れる必要が出たら、タスクを止めて ADR を起票する。
- 外部境界（IMAP / SMTP / AWS SDK）はインターフェースで抽象化し、ユニットテストではフェイクまたは `aws-sdk-client-mock` を使う。
- 「手動確認」と書かれたタスクは AWS / GitHub / Claude の実環境が必要で、エージェントは手順を整えて人間に依頼する。

## フェーズ 0: 足場

- [x] **T-001: プロジェクト初期化**
  - 目的: TypeScript / vitest / esbuild の土台と npm スクリプト（`test`, `test:smoke`, `build`）を用意する
  - 対応要件: NFR-007
  - 対象ファイル: package.json, tsconfig.json, vitest.config.ts, .gitignore, src/core/.gitkeep, test/unit/smoke.test.ts
  - 最初に書くテスト: `test/unit/smoke.test.ts` で `1 + 1 = 2` を検証するダミーテスト
  - 完了条件: `npm test` が成功する。`npm run test:smoke` が「未実装」ではなく test/smoke ディレクトリを実行する（この時点では 0 件でも可）
  - 依存: なし

- [x] **T-002: CDK 足場と stage コンテキスト**
  - 目的: `cdk deploy --all --context stage=dev|prod` でスタック名 `MailMcp-<stage>` が切り替わる空スタックを作る
  - 対応要件: NFR-003
  - 対象ファイル: infra/bin/app.ts, infra/lib/mail-mcp-stack.ts, cdk.json, test/unit/infra/stack.test.ts
  - 最初に書くテスト: CDK assertions で stage=dev と stage=prod でスタック名が異なり、stage 未指定でエラーになる
  - 完了条件: `npx cdk synth --all --context stage=dev` が成功し、テストが通る
  - 依存: T-001

- [x] **T-003: 正常性テストの足場**
  - 目的: `npm run test:smoke` が `CDK_OUTPUTS_FILE` と `STAGE` を読み、スタック出力を取得できる
  - 対応要件: NFR-006
  - 対象ファイル: test/smoke/outputs.ts, test/smoke/outputs.test.ts
  - 最初に書くテスト: outputs ファイルが無いとき明確なエラーで失敗する / ある場合はスタック `MailMcp-<stage>` の出力オブジェクトを返す
  - 完了条件: ローカルで outputs ファイル（手書き JSON）を与えて実行できる
  - 依存: T-002

- [x] **T-004: CI/CD の有効化（手動確認）**
  - 目的: `.github/workflows/README.md` に従い dev / prod アカウントに OIDC ロールを作り、Repository variables を設定し、develop への push で dev デプロイと main 昇格が動く。3 ワークフローに `npm run build` ステップを追加し（ADR-0005: QEMU / buildx は不要）、OIDC プロバイダとデプロイロール（`iam:CreateServiceLinkedRole` 付き）を CloudFormation で両アカウントに作成し、Repository variables を設定する
  - 対応要件: NFR-003
  - 対象ファイル: .github/workflows/ci.yml, deploy-dev.yml, deploy-prod.yml（build ステップ追加）、infra/bootstrap/github-oidc.yaml（OIDC プロバイダ + デプロイロール）、GitHub / AWS 設定
  - 最初に書くテスト: -（手動確認: deploy-dev が成功し main が更新される）
  - 完了条件: deploy-dev / deploy-prod が green
  - 依存: T-003

## フェーズ 1: コアライブラリ（純粋ロジックと外部境界のラッパ）

- [x] **T-005: メッセージ ID の導出とログの秘匿**
  - 目的: `ids.ts`（Message-ID → 32 桁 hex、無い場合は folder/uidValidity/uid から導出）と `logger.ts`（`password` / `authorization` / `body` / `text` キーを落とす構造化ログ）
  - 対応要件: REQ-001, REQ-052, NFR-008
  - 対象ファイル: src/core/ids.ts, src/core/logger.ts, test/unit/core/ids.test.ts, test/unit/core/logger.test.ts
  - 最初に書くテスト: 同じ Message-ID から同じ id が得られる / Message-ID 無しでフォルダ・UID から導出される / ログ出力に `password` の値が含まれない
  - 完了条件: テスト 4 本が通る
  - 依存: T-001

- [x] **T-006: MIME 解析**
  - 目的: `mime.ts` が生メッセージからヘッダ・テキスト本文（HTML のみならテキスト化）・添付メタ情報を返す
  - 対応要件: REQ-011, REQ-001
  - 対象ファイル: src/core/mime.ts, test/fixtures/*.eml（plain / html-only / attachment / 日本語 ISO-2022-JP）, test/unit/core/mime.test.ts
  - 最初に書くテスト: text/plain フィクスチャで本文が返る / html-only でテキスト化される / 添付付きでファイル名・サイズ・MIME タイプが返り本体は含まれない / ISO-2022-JP の件名が正しくデコードされる
  - 完了条件: テストが通る。`mailparser` を依存に追加
  - 依存: T-005

- [x] **T-007: メッセージ組立（新規・返信・転送）**
  - 目的: `compose.ts` の純粋関数 `buildNew` / `buildReply` / `buildForward` が nodemailer の `Mail.Options` を返す
  - 対応要件: REQ-020, REQ-021, REQ-022
  - 対象ファイル: src/core/compose.ts, test/unit/core/compose.test.ts
  - 最初に書くテスト: 返信で In-Reply-To / References が元 Message-ID を含む / `Re:` が重複しない / 全員返信で自分のアドレスが除かれる / 転送で `Fwd:` と引用本文・添付があった旨が入る / 宛先 0 件・形式不正で例外
  - 完了条件: テスト 5 本が通る。Message-ID は呼出側から渡せる
  - 依存: T-006

- [x] **T-008: 検索条件の組立**
  - 目的: `search.ts` が検索入力（folder / from / to / subject / since / before / unreadOnly / flaggedOnly / limit / cursor）を DynamoDB Query パラメータと部分一致フィルタ関数に変換する
  - 対応要件: REQ-010
  - 対象ファイル: src/core/search.ts, test/unit/core/search.test.ts
  - 最初に書くテスト: 日時未指定で直近 90 日の範囲になる / limit 既定 20・上限 100 / 件名・差出人が大文字小文字を無視した部分一致でフィルタされる / cursor の往復
  - 完了条件: テストが通る
  - 依存: T-005

- [x] **T-009: MailStore（DynamoDB + S3）**
  - 目的: `store.ts` が Message / Folder / SyncState / Scheduled アイテムの読み書きと S3 の生メッセージ Put/Get/Delete を提供する（design.md 4 章のキー設計）
  - 対応要件: REQ-001, REQ-003, REQ-010, REQ-011, NFR-002
  - 対象ファイル: src/core/store.ts, src/core/types.ts, test/unit/core/store.test.ts
  - 最初に書くテスト（`aws-sdk-client-mock`）: putMessage が PK/SK/GSI1/GSI2/ttl を正しく組む / listByDate が GSI2 を降順で Query する / listFolderUids が GSI1 を射影付きで Query する / updateFlags が UpdateItem を発行する / putRaw が `raw/<id>.eml` へ PUT する
  - 完了条件: テスト 5 本が通る
  - 依存: T-005

- [x] **T-010: 設定とシークレット読込（MX からのホスト導出）**
  - 目的: `secrets.ts` が Secrets Manager `mail-mcp/<stage>/mail` の JSON（design.md 5 章。必須は `domain` / `user` / `password`）を型付きで読み、既定値を補い、`imapHost` / `smtpHost` 省略時は `dns.promises.resolveMx(domain)` の優先度最小ホストを使い、ログイン名 `<user>@<domain>` を組み立て、プロセス内でキャッシュする
  - 対応要件: REQ-052
  - 対象ファイル: src/core/secrets.ts, test/unit/core/secrets.test.ts
  - 最初に書くテスト: 必須キー欠落でエラー / `domain` `user` `password` だけの JSON で MX（モック）からホストが導出されログイン名が `user@domain` になる / `imapHost` 指定時は MX を引かない / MX 解決失敗のエラーにパスワードが含まれない / 2 回目の呼出で GetSecretValue と MX 解決が再発行されない
  - 完了条件: テスト 5 本が通る
  - 依存: T-005

- [x] **T-011: ImapSession（imapflow ラッパ）**
  - 目的: `imap.ts` に `ImapSession` インターフェース（listFolders / select / fetchNew / fetchFlags / setFlags / move / append / searchSent）と imapflow 実装を作る。移動は CAPABILITY に MOVE があれば `UID MOVE`、無ければ `UID COPY` + `\Deleted`。EXPUNGE は発行しない
  - 対応要件: REQ-030〜033, REQ-012, REQ-020
  - 対象ファイル: src/core/imap.ts, src/core/imap-fake.ts（テスト用フェイク）, test/unit/core/imap.test.ts, test/unit/core/no-expunge.test.ts
  - 最初に書くテスト: 非対応時（さくら: CAPABILITY に MOVE 無し）に COPY + \Deleted を呼び COPYUID から新 UID を返し EXPUNGE を呼ばない / MOVE 対応時に UID MOVE を呼ぶ / 特殊フォルダを SPECIAL-USE から解決し無ければ設定値（`INBOX.Sent` / `INBOX.Trash`）を使う / ログインのユーザ名にメールアドレス全体を渡す / 静的テスト: `src/` 内に `expunge` を含む呼出が無い
  - 完了条件: テストが通る。`imapflow` を依存に追加
  - 依存: T-010

- [x] **T-012: SmtpSender（nodemailer ラッパ + Sent APPEND）**
  - 目的: `smtp.ts` が Message-ID を採番し、SMTP 送信後に同じ内容を IMAP の Sent フォルダへ APPEND する。SMTP 失敗時は APPEND しない
  - 対応要件: REQ-020
  - 対象ファイル: src/core/smtp.ts, test/unit/core/smtp.test.ts
  - 最初に書くテスト（フェイク transport + フェイク ImapSession）: 送信成功で Sent に同じ Message-ID が APPEND される / SMTP 失敗で APPEND されず例外 / From が設定値固定
  - 完了条件: テスト 3 本が通る。`nodemailer` を依存に追加
  - 依存: T-007, T-011

- [x] **T-013: 予約送信の状態遷移**
  - 目的: `scheduled.ts` が `pending → sending → sent | failed`、`pending → cancelled` を DynamoDB の条件付き更新で行う純粋な遷移関数群を提供する
  - 対応要件: REQ-040〜043
  - 対象ファイル: src/core/scheduled.ts, test/unit/core/scheduled.test.ts
  - 最初に書くテスト: `claimSending` が `status = pending` 条件付きで更新する / 条件失敗時に現在状態を返す / `markSent` / `markFailed` が attempts と error を記録する / 終端状態で ttl（+90 日）が付く
  - 完了条件: テストが通る
  - 依存: T-009

## フェーズ 2: データ層インフラと同期ジョブ

- [x] **T-014: CDK: データ層（DynamoDB / S3 / Secrets Manager）**
  - 目的: `MailTable-<stage>`（GSI1 / GSI2、TTL、PITR、オンデマンド）、生メッセージバケット（SSE-S3、BlockPublicAccess、enforceSSL、365 日ライフサイクル）、`mail-mcp/<stage>/mail` シークレット（プレースホルダ）を定義する
  - 対応要件: NFR-002, NFR-004
  - 対象ファイル: infra/lib/mail-mcp-stack.ts, test/unit/infra/data.test.ts
  - 最初に書くテスト: CDK assertions で TTL 属性 `ttl`、GSI 2 本、S3 のライフサイクル 365 日と BlockPublicAccess、シークレット名
  - 完了条件: テストが通り `cdk synth` が成功する
  - 依存: T-002

- [x] **T-015: 同期: フォルダ列挙と初回判定**
  - 目的: `sync/folders.ts` が全フォルダを列挙し、SyncState の有無 / UIDVALIDITY 変化から「初回（過去 90 日）」「差分」「再取込」を判定し、Folder アイテムの特殊フォルダ属性を保存する
  - 対応要件: REQ-002, REQ-012, REQ-001
  - 対象ファイル: src/sync/folders.ts, test/unit/sync/folders.test.ts
  - 最初に書くテスト: SyncState 無しで初回モードになり SINCE 90 日の検索条件が作られる / UIDVALIDITY 不一致で再取込モード / 一致で lastUid+1 からの差分モード
  - 完了条件: テスト 3 本が通る
  - 依存: T-011, T-009

- [x] **T-016: 同期: 取込フェーズ**
  - 目的: `sync/ingest.ts` が対象 UID を 50 通ずつ取得し（`BODY.PEEK[]`）、S3 と DynamoDB へ保存、50 通ごとに lastUid を進め、時間予算（注入した時計）を超えたら中断する
  - 対応要件: REQ-001, REQ-004
  - 対象ファイル: src/sync/ingest.ts, test/unit/sync/ingest.test.ts
  - 最初に書くテスト: 120 通で 3 バッチに分かれ lastUid が段階的に進む / 同じ Message-ID の再取込で PutItem が同じ PK に上書きされる（重複なし）/ 時間予算超過で中断し、再実行で残りだけ取り込む
  - 完了条件: テスト 3 本が通る
  - 依存: T-015, T-006

- [x] **T-017: 同期: 照合フェーズとフォルダ集計**
  - 目的: `sync/reconcile.ts` がフォルダ内の UID/FLAGS と DynamoDB の既知集合を突き合わせ、フラグ差分を更新し、IMAP に無いメッセージ（他フォルダで再発見されていないもの）を削除し、Folder の total / unread を更新する
  - 対応要件: REQ-003, REQ-012
  - 対象ファイル: src/sync/reconcile.ts, test/unit/sync/reconcile.test.ts
  - 最初に書くテスト: クライアント側で既読になった UID が DynamoDB で seen=true になる / 移動で他フォルダに再登録済みの id は削除されない / 消失した id と \Deleted 付きの id は DynamoDB と S3 から削除される / total・unread が一致する
  - 完了条件: テスト 4 本が通る
  - 依存: T-016

- [x] **T-018: 同期 Lambda ハンドラと CDK（Scheduler rate 15 分）**
  - 目的: `sync/handler.ts` が T-015〜017 を順に実行し、CDK で Lambda（`NodejsFunction`, 512 MB, 15 分, VPC 外）と EventBridge Scheduler の `rate(15 minutes)` を定義する
  - 対応要件: REQ-001, NFR-004
  - 対象ファイル: src/sync/handler.ts, infra/lib/mail-mcp-stack.ts, test/unit/sync/handler.test.ts, test/unit/infra/sync.test.ts
  - 最初に書くテスト: ハンドラが取込未完了なら照合を実行しない / CDK assertions で Scheduler の rate 式、Lambda のロールが S3 Put/Delete と DynamoDB のみを持ち Scheduler 権限を持たない
  - 完了条件: テストが通り、develop への push で dev に同期 Lambda がデプロイされる（Secrets を設定すれば 15 分後に DynamoDB へメールが入る: 手動確認）
  - 依存: T-017, T-014, T-004

## フェーズ 3: MCP サーバと認証

- [x] **T-019: MCP サーバの骨格（ツールなし）**
  - 目的: `mcp/server.ts`（McpServer 構築）と `mcp/main.ts`（`0.0.0.0:8000`、`POST /mcp` ステートレス JSON 応答、`GET /ping`）を作る
  - 対応要件: REQ-050
  - 対象ファイル: src/mcp/server.ts, src/mcp/main.ts, test/unit/mcp/server.test.ts
  - 最初に書くテスト: プロセス内で起動し SDK のクライアントから `initialize` と `tools/list`（空）が成功する / `Mcp-Session-Id` ヘッダ付きの要求が拒否されない / `GET /mcp` が 405
  - 完了条件: テスト 3 本が通る。`@modelcontextprotocol/sdk`, `zod` を依存に追加
  - 依存: T-001

- [x] **T-020: ツール: list_folders / search_messages / get_message**
  - 目的: 閲覧系 3 ツールを zod スキーマ付きで登録し、MailStore と mime.ts を使って応答する
  - 対応要件: REQ-010, REQ-011, REQ-012
  - 対象ファイル: src/mcp/tools/list_folders.ts, search_messages.ts, get_message.ts, test/unit/mcp/tools-read.test.ts
  - 最初に書くテスト: 検索結果に本文が含まれない / 0 件で空一覧 / get_message が存在しない id で `isError` / html-only メールがテキストで返る
  - 完了条件: テスト 4 本が通る
  - 依存: T-019, T-008, T-009, T-006

- [x] **T-021: ツール: send_message / reply_message / forward_message**
  - 目的: 送信系 3 ツールを登録し、compose.ts と SmtpSender で送信する
  - 対応要件: REQ-020, REQ-021, REQ-022
  - 対象ファイル: src/mcp/tools/send_message.ts, reply_message.ts, forward_message.ts, test/unit/mcp/tools-send.test.ts
  - 最初に書くテスト: 宛先不正で送信されず `isError` / 返信元 id が無ければ `isError` / 成功時に messageId が返り Sent への APPEND が呼ばれる
  - 完了条件: テスト 3 本が通る
  - 依存: T-020, T-012

- [x] **T-022: ツール: set_read / set_flagged / move_message / trash_message**
  - 目的: 整理系 4 ツールを登録し、「IMAP 成功 → DynamoDB 更新」の順序を守る
  - 対応要件: REQ-030〜033
  - 対象ファイル: src/mcp/tools/set_read.ts, set_flagged.ts, move_message.ts, trash_message.ts, test/unit/mcp/tools-organize.test.ts
  - 最初に書くテスト: IMAP 失敗時に DynamoDB が更新されず `isError` / 移動先不存在で変更なし / trash_message が Trash フォルダへの move を呼ぶ / 移動後に folder と uid が更新される
  - 完了条件: テスト 4 本が通る
  - 依存: T-020, T-011

- [x] **T-023: ツール: schedule_message / list_scheduled_messages / cancel_scheduled_message**
  - 目的: 予約系 3 ツールを登録し、DynamoDB へ `pending` を書いてから EventBridge Scheduler に `at(<日時>)` の一回限りスケジュールを作る。登録失敗時は `pending` を消す
  - 対応要件: REQ-040, REQ-041
  - 対象ファイル: src/mcp/tools/schedule_message.ts, list_scheduled_messages.ts, cancel_scheduled_message.ts, src/core/scheduler.ts, test/unit/mcp/tools-schedule.test.ts
  - 最初に書くテスト: 過去日時 / 1 年超で `isError` / Scheduler の CreateSchedule 失敗で DynamoDB の予約が削除される / pending 以外の取消で `isError` / 取消で DeleteSchedule が呼ばれ状態が cancelled になる
  - 完了条件: テスト 4 本が通る。`@aws-sdk/client-scheduler` を依存に追加
  - 依存: T-020, T-013

- [x] **T-024: コンテナ化（Dockerfile + esbuild バンドル）**
  - 目的: `npm run build` が `dist/mcp/main.js` を生成し、`docker/Dockerfile`（node:22-slim, ARM64。`dist/mcp/main.js` をコピーするだけ）でイメージが動く。ビルドコンテキストはリポジトリルートで `.dockerignore` により `dist/mcp` と `docker/` に限定する
  - 対応要件: REQ-050
  - 対象ファイル: docker/Dockerfile, .dockerignore, build.mjs（esbuild）, package.json, test/unit/build.test.ts
  - 最初に書くテスト: build 後に `dist/mcp/main.js` が存在し、`node dist/mcp/main.js` を子プロセスで起動して `GET /ping` が 200 を返す
  - 完了条件: テストが通り、ローカルで `npm run build && docker build -f docker/Dockerfile .`（ホストのアーキテクチャ）と `docker run -p 8000:8000` の後 `tools/list` が返る（ARM64 ビルドは ADR-0005 によりデプロイ時に CodeBuild が行う）
  - 依存: T-023

- [x] **T-025: CDK: Cognito（User Pool / ドメイン / アプリクライアント / 正常性テスト用ユーザ）**
  - 目的: セルフサインアップ無効の User Pool、Managed Login ドメイン、公開アプリクライアント（Authorization Code + PKCE、コールバック `http://localhost:8765/callback` と `https://claude.ai/api/mcp/auth_callback`、`USER_PASSWORD_AUTH` 許可）、`AwsCustomResource` で smoke ユーザを作成し Secrets Manager `mail-mcp/<stage>/smoke-user` に生成パスワードを保存する
  - 対応要件: REQ-051, NFR-006
  - 対象ファイル: infra/lib/mail-mcp-stack.ts, test/unit/infra/cognito.test.ts
  - 最初に書くテスト: CDK assertions で `AllowAdminCreateUserOnly` / 2 つのコールバック URL / GenerateSecret=false / smoke-user シークレットの存在
  - 完了条件: テストが通り `cdk synth` が成功する。Outputs に `UserPoolId`, `UserPoolClientId`, `CognitoDomain`, `SmokeUserSecretArn`
  - 依存: T-014

- [x] **T-026: CDK: AgentCore Runtime**
  - 目的: `aws_bedrockagentcore.Runtime`（`@cdklabs/deploy-time-build` の `ContainerImageBuild`（`directory: '.'`, `file: 'docker/Dockerfile'`, `platform: LINUX_ARM64`）でデプロイ時に CodeBuild がビルドしたイメージを `AgentRuntimeArtifact.fromEcrRepository(image.repository, image.imageTag)` で渡す（ADR-0005）、`ProtocolType.MCP`、`RuntimeAuthorizerConfiguration.usingJWT(<Cognito discovery URL>, [<client id>])`、PUBLIC ネットワーク、環境変数 `STAGE` / `TABLE_NAME` / `BUCKET_NAME` / `MAIL_SECRET_ARN` / `SCHEDULE_GROUP`、idle timeout 5 分、実行ロールに DynamoDB R/W・S3 Get・Secrets Get・Scheduler Create/Delete・PassRole）を定義する
  - 対応要件: REQ-050, REQ-051, NFR-004
  - 対象ファイル: infra/lib/mail-mcp-stack.ts, test/unit/infra/agentcore.test.ts
  - 最初に書くテスト: CDK assertions で protocol MCP、discovery URL が User Pool を指す、allowedClients にアプリクライアント ID、実行ロールが S3 Put を持たない、CodeBuild プロジェクトが ARM 環境である
  - 完了条件: テストが通り、develop への push で dev に Runtime がデプロイされ、Cognito の smoke ユーザのトークンで AgentCore 呼出 URL の `tools/list` が成功する（手動確認）。Outputs に `AgentRuntimeArn`
  - 依存: T-024, T-025, T-004

- [x] **T-027: CDK: CloudFront façade と CloudFront Functions**
  - 目的: `infra/functions/viewer-request.js`（well-known 2 本の応答、`/mcp` の URI 書換と `qualifier=DEFAULT` 付与、その他 404）と `viewer-response.js`（401 の `WWW-Authenticate` 上書き）を作り、CloudFront ディストリビューション（オリジン = AgentCore エンドポイント、CachingDisabled、AllViewerExceptHostHeader、許可メソッド ALL）に関連付ける。プレースホルダは synth 時に置換する
  - 対応要件: REQ-051, REQ-050
  - 対象ファイル: infra/functions/viewer-request.js, infra/functions/viewer-response.js, infra/lib/mail-mcp-stack.ts, test/unit/infra/functions.test.ts, test/unit/infra/cloudfront.test.ts
  - 最初に書くテスト: 関数を直接呼び、PRM の `resource` が `<façade>/mcp` / AS メタデータに `code_challenge_methods_supported: ["S256"]` と Cognito の endpoint / `/mcp` の URI が `/runtimes/<encoded ARN>/invocations` に書き換わる / 401 で WWW-Authenticate が上書きされ 200 では変わらない。CDK assertions で 2 関数の関連付けとオリジンドメイン
  - 完了条件: テスト 5 本が通る。Outputs に `McpUrl`（`https://<distribution>.cloudfront.net/mcp`）。dev で well-known 2 本が 200 を返す（手動確認）
  - 依存: T-026

- [x] **T-028: 正常性テスト本体**
  - 目的: `test/smoke/` が Secrets Manager の smoke-user で `InitiateAuth (USER_PASSWORD_AUTH)` のトークンを取り、design.md 9 章のユースケース（無トークン 401 + WWW-Authenticate、well-known 2 本、`initialize` / `tools/list` = 13 ツール、`list_folders` → `search_messages` → `get_message`、`schedule_message`（11 か月後・宛先自分）→ `list_scheduled_messages` → `cancel_scheduled_message`、各呼出の応答時間）を実行する
  - 対応要件: NFR-005, NFR-006, REQ-050, REQ-051
  - 対象ファイル: test/smoke/auth.ts, test/smoke/mcp-client.ts, test/smoke/*.smoke.test.ts
  - 最初に書くテスト: 無トークンで 401 と façade の PRM を指す WWW-Authenticate が返る
  - 完了条件: deploy-dev の正常性テストが green になり main が更新される
  - 依存: T-027, T-003

- [x] **T-029: 認証 E2E（Claude Code からの接続、手動確認）**
  - 目的: `claude mcp add --transport http --client-id <UserPoolClientId> --callback-port 8765 mail <McpUrl>` でブラウザログインが完了し `tools/list` が見えることを確認する。失敗した場合は ADR-0004 を Superseded にして DCR シム案の ADR を起票する
  - 対応要件: REQ-051, REQ-050
  - 対象ファイル: README.md（登録手順）、必要なら .spec/adr/0005-*.md
  - 最初に書くテスト: -（手動確認）
  - 完了条件: Claude Code から `list_folders` が実行できる。手順が README に書かれている
  - 依存: T-028

## フェーズ 4: 予約送信の実行系

- [x] **T-030: scheduled-send Lambda ハンドラ**
  - 目的: `scheduled-send/handler.ts` が `{ scheduleId }` を受け、`claimSending` → SMTP 送信 → Sent APPEND → `markSent`。`sending` で再発火した場合は Sent を Message-ID で検索し、あれば `sent`、無ければ `failed(unknown-delivery)`。SMTP 例外は attempts を加算して再スロー、3 回目で `failed`。`failed` 遷移時に EMF メトリクス `ScheduledSendFailed` を出力
  - 対応要件: REQ-042, REQ-043, NFR-008
  - 対象ファイル: src/scheduled-send/handler.ts, test/unit/scheduled-send/handler.test.ts
  - 最初に書くテスト: 同一 scheduleId の同時 2 発火で SMTP 送信が 1 回 / `sending` で再発火し Sent に無ければ再送せず failed / cancelled では何もしない / 3 回目の失敗で failed とメトリクス出力
  - 完了条件: テスト 4 本が通る
  - 依存: T-013, T-012

- [x] **T-031: CDK: scheduled-send Lambda・Scheduler グループ・アラーム**
  - 目的: scheduled-send Lambda（ロールは DynamoDB の Scheduled アイテムと Secrets のみ、S3 なし）、Scheduler のスケジュールグループ `mail-mcp-<stage>` とターゲット起動ロール（再試行 3 回）、メトリクス `ScheduledSendFailed` のアラームと SNS トピック（メール購読先は context `alarmEmail`）を定義する
  - 対応要件: REQ-042, NFR-004, NFR-008
  - 対象ファイル: infra/lib/mail-mcp-stack.ts, test/unit/infra/scheduled-send.test.ts
  - 最初に書くテスト: CDK assertions でアラームの存在とメトリクス名、Lambda ロールに S3 権限が無い、mcp-server 実行ロールの PassRole がターゲット起動ロールに限定されている
  - 完了条件: テストが通り、dev で `schedule_message`（2 分後・宛先自分）→ 実際に届き Sent にも残る（手動確認）
  - 依存: T-030, T-026

## フェーズ 5: 仕上げ

- [x] **T-032: README と運用手順**
  - 目的: デプロイ後の一回限りの手順（Secrets の値設定、Cognito 開発者ユーザ作成、Claude Code / Desktop への登録、アラームメールの購読確認）、ローカル開発（コンテナ起動、MCP Inspector）、コスト上限の目安を README に書く
  - 対応要件: NFR-001, NFR-006
  - 対象ファイル: README.md
  - 最初に書くテスト: -（ドキュメント。手順どおりに新しい環境で接続できることを手動確認）
  - 完了条件: README の手順だけで prod への登録が完了する
  - 依存: T-029, T-031

## 完了ログ

| タスク | 完了日 | 備考 |
|--------|--------|------|
| T-001 | 2026-09-19 | 依存パッケージは後続タスク分も一括で導入（typescript は 5.x に固定、@types/node は 22 に固定）。`build.mjs` は T-024 で作成。ADR-0005（deploy-time-build 採用）を起票し design.md / T-004 / T-024 / T-026 を同期 |
| T-002 | 2026-09-19 | `resolveStage(app)` を stack ファイルから export。env は region 固定・account は CDK_DEFAULT_ACCOUNT。`cdk synth --all` は CLI 2.1142 で `--all` が無視されるが成功する |
| T-003 | 2026-09-19 | `loadOutputs(env)` は環境変数を注入可能。テストは test/smoke 配下（smoke 実行時にも走るが AWS 不要） |
| T-005 | 2026-09-19 | ids 4 本 + logger 3 本。`redact` は `raw` キーも秘匿対象に追加 |
| T-006 | 2026-09-19 | テスト 5 本。html-only は mailparser が自動で html-to-text 変換する。ISO-2022-JP フィクスチャは encoding-japanese で生成 |
| T-007 | 2026-09-19 | テスト 11 本。`newMessageId(domain)` を compose.ts に置き、smtp / ツールが共用する |
| T-008 | 2026-09-19 | テスト 8 本。大小無視の部分一致は保存時に小文字化した `subjectLower` / `fromLower` / `toLower` に対する `contains` で実現 |
| T-010 | 2026-09-19 | テスト 6 本。`loadMailConfig({ secretId?, client?, resolveMx? })` + `resetMailConfigCache()` |
| T-014 | 2026-09-19 | テスト 6 本。RemovalPolicy は prod=RETAIN / dev=DESTROY（design.md 4 章に追記）。infra テストは `beforeAll` で 1 回だけ synth（autoDeleteObjects のアセットステージングが遅いため） |
| T-019 | 2026-09-19 | テスト 3 本。SDK 1.30 はツール 0 個だと tools/list が -32601 になるためテストは echo ツールを 1 つ登録して検証。`createMcpServer(register?)` / `createHttpServer(register?)` |
| T-009 | 2026-09-19 | テスト 14 本。Folder アイテムにも GSI2（`FOLDER` / name）を付け `listFolders` を Query で実装（design.md 4 章に追記）。DocumentClient は `removeUndefinedValues` |
| T-011 | 2026-09-19 | テスト 12 本 + 静的テスト 1 本。imapflow の `messageMove` は MOVE 非対応時に EXPUNGE するため自前で COPY + \Deleted。`n:*` の結果は `uid >= n` でフィルタ。SPECIAL-USE は `specialUseSource !== 'name'` のみ採用 |
| T-013 | 2026-09-19 | テスト 9 本。条件失敗時の現在状態は再 Get で取得（lib-dynamodb は `ConditionalCheckFailedException.Item` を unmarshall しないため） |
| T-015 | 2026-09-19 | テスト 5 本。初回の途中終了は `uidFrom` 付き initial として再開 |
| T-016 | 2026-09-19 | テスト 5 本。`\\Deleted` 付きはスキップ。時間予算は `clock.remainingMs() < 60 秒` で中断 |
| T-017 | 2026-09-19 | テスト 5 本。削除前に `getMessage` で所属を再確認（GSI1 の結果整合性対策） |
| T-020 | 2026-09-19 | テスト 7 本。nextCursor は `queryMessages` がキーを剥がすため `keys.*` で最後の項目のキーを復元 |
| T-022 | 2026-09-19 | テスト 7 本。共通処理は `src/mcp/tools/organize.ts`。DynamoDB 更新は IMAP 成功直後（セッション内） |
| T-023 | 2026-09-19 | テスト 9 本。`EventBridgeSendScheduler`（at() 式、ActionAfterCompletion=DELETE、再試行 3 回）。宛先検証は `buildNew` を呼ぶだけ |
| T-004 | 2026-09-19 | OIDC ロールは `infra/bootstrap/github-oidc.yaml` で作成（sub は environment 付き・数値 ID 付き形式も許可、smoke-user シークレット読取を付与）。deploy-dev → main 昇格 → deploy-prod が green（run 35429068598） |
| T-012 | 2026-09-19 | テスト 4 本。`SendError.phase` で SMTP 失敗（未送信）と APPEND 失敗（送信済み）を区別 |
| T-021 | 2026-09-19 | テスト 6 本。共通処理は `src/mcp/tools/sending.ts` |
| T-030 | 2026-09-19 | テスト 7 本。同時重複発火は `updatedAt` が 5 分以内の `sending` を「進行中」とみなし何もしない（design.md 3.3 に追記）。SMTP 失敗は `releaseToPending` で pending に戻して再スロー、3 回目で failed |
| T-024 | 2026-09-19 | ビルドテストは `dist/mcp/main.js` を子プロセス起動し tools/list が 13 ツールを返すことを確認。ローカルで `docker build`（amd64, 81 MB）→ `docker run` → /ping 200・tools 13 を確認。ベースイメージは Docker Hub のレート制限を避け `public.ecr.aws/docker/library/node:22-slim` |
| T-018 | 2026-09-19 | ハンドラテスト 3 本 + CDK assertions 3 本。構成は `infra/lib/sync-job.ts`（Scheduler L2 `Schedule` + `LambdaInvoke`、起動ロールは scheduled-send と共用）。dev で確認済み: Secrets 投入後の初回同期で実メールボックスから 3 通が DynamoDB / S3 に入り、Folder の total / unread / lastSyncAt が 15 分周期で更新される |
| T-025 | 2026-09-19 | テスト 5 本。`signInAliases` は username + email（smoke ユーザ名 `smoke` のため）。新 Managed Login には `CfnManagedLoginBranding` が必須。`AdminSetUserPassword` は動的参照でパスワードを渡し `Logging.withDataHidden()` |
| T-026 | 2026-09-19 | テスト 5 本。`RuntimeAuthorizerConfiguration.usingCognito(userPool, [client])`、`AgentRuntimeArtifact.fromEcrRepository(image.repository, image.imageTag)`。`ContainerImageBuild` は `ignoreMode: IgnoreMode.DOCKER` 必須（GLOB だと `.env` 等が入る）。Scheduler グループと起動ロールもここで作成。dev で確認済み: smoke ユーザのトークンで façade 経由の tools/list が 13 ツールを返す（initialize 1.6 秒、各ツール 0.4 秒） |
| T-027 | 2026-09-19 | 関数テスト 7 本 + CDK 3 本。façade 自身の URL は Host ヘッダから実行時に組み立てる。dev 実機で CloudFront がオリジンの 401 に viewer-response を呼ばない（`x-cache: Error from cloudfront`）と判明し、viewer-response を廃止して viewer-request がトークン無し / 期限切れを判定して 401 を返す方式に変更（テスト 9 本 + CDK 3 本）。well-known 2 本は dev で 200 を確認 |
| T-031 | 2026-09-19 | テスト 5 本。構成は `infra/lib/scheduled-send.ts`（タイムアウト 5 分、DynamoDB は `LeadingKeys = SCHED#*` に限定、S3 なし）。SNS 宛先は context `alarmEmail`（cdk.json）。実送信の手動確認は deploy-dev 後 |
| T-032 | 2026-09-19 | README にセットアップ（bootstrap / OIDC / Repository variables）、デプロイ、デプロイ後の一回限りの手順（Secrets、Cognito ユーザ `developer`、Claude 登録、アラーム購読）、ローカル開発、コスト、運用メモを記載。「README の手順だけで prod へ登録できる」の実地確認は人間が行う |
| T-028 | 2026-09-19 | smoke 5 本 + outputs 4 本。deploy-dev（run 35431240064）で green になり main へ昇格。宛先は `smoke-test@example.invalid`（メール設定を読まないため）。判明した 2 件（動的参照が custom resource で解決されない / viewer-response がオリジンの 401 で呼ばれない）は L-0017 / L-0018 |
| ADR-0006 | 2026-09-19 | id = sha256(Message-ID + folder)。移動は新レコード作成 → 旧レコード削除（s3Key は共有、MCP ロールは S3 に書かない）。照合の生メッセージ削除は s3Key で行う。`updateLocation` / `deleteRaw(id)` は削除。テスト 181 本 |
| lastSyncAt 追加 | 2026-09-19 | REQ-012 を更新し、`list_folders` の応答に同期時刻 `lastSyncAt` を追加（件数がスナップショットであることをモデルが説明できるように）。テスト 1 本更新 |
| 実機テスト修正 | 2026-09-19 | Claude Desktop での手順 1〜6（2026-09-19）で判明した不具合 3 件を TDD で修正: 自分→自分のメールへの返信で宛先が空になる（REQ-021 どおり元 From へ）/ 存在しないフォルダへの移動が「uid not found」になる（imapflow が false を返すため移動先の存在確認を追加）/ タグ無し text/html のみのメールで本文が空（html-to-text で変換）。設計上の制約 2 件（同一 Message-ID の複数フォルダ、list_folders の件数は 15 分周期の同期スナップショット）はユーザ判断待ち |
| T-029 | 2026-09-19 | Claude Desktop（claude.ai カスタムコネクタ、client ID 入力、シークレット無し）で prod に接続できることを人間が確認。初回は Cognito が `resource` を拒否して失敗し、リソースサーバ登録（ADR-0004 訂正、L-0020）で解消。Claude Code（`--callback-port 8765`）はブラウザのあるマシンで別途確認 |
