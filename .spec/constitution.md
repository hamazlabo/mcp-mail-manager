# プロジェクト憲法 (constitution.md)

このファイルは人間が管理する。AI エージェントは読むだけで、書き換えない。
spec（specify / requirements / design / task / adr）はすべてこの憲法に従う。
憲法と矛盾する提案をする場合は、ADR として起票し人間の承認を得る。

## 1. プラットフォーム: AWS 前提

- インフラは AWS 上に構築する。マルチクラウドや他クラウドの前提を持ち込まない。
- IaC で管理する（AWS CDK を第一候補、代替は SAM / Terraform）。コンソール手作業を正とする設計を禁止する。
- 認証・認可・シークレットは AWS のマネージド機能を使う（IAM, Cognito, Secrets Manager, SSM Parameter Store）。
- リージョンは `ap-northeast-1` を既定とする。

## 2. コスト: サーバレス優先

- 常時起動のコンピュート（EC2, ECS on EC2, 常時起動の RDS）より、従量課金のサーバレスを優先する。
  - コンピュート: Lambda → Fargate → EC2 の順で検討する。
  - データ: DynamoDB → Aurora Serverless v2 → RDS の順で検討する。
  - 非同期・連携: EventBridge, SQS, Step Functions, SNS。
  - API: API Gateway (HTTP API を優先) / Lambda Function URL。
- サーバレスを選ばない場合は、ADR に理由（レイテンシ・コスト試算・運用要件）を明記する。
- 設計時に月額コストの概算を design.md に記載する。
- アイドル時コストがゼロに近い構成を良しとする。

## 3. 開発プロセス: TDD 前提

- すべての実装タスクは「テストを先に書き、失敗を確認し、通す」順序で進める（Red → Green → Refactor）。
- task.md の各タスクは「最初に書くテスト」と「完了条件」を必ず持つ。
- テストのない振る舞いを追加しない。バグ修正は再現テストから始める。
- テストの階層:
  - ユニットテスト: ビジネスロジック。AWS SDK はモック化する。
  - 統合テスト: AWS リソースに依存する境界（DynamoDB Local, LocalStack, または実環境のテスト用スタック）。
  - E2E: 主要ユースケースのみ。
- CI でユニットテストが通らないものはマージしない。
- ブランチ運用: `develop` への push で dev アカウントへ自動デプロイし、正常性テストを通過した commit だけを `main` に昇格する。人間は `main` に直接 push しない。
- 正常性テスト (`npm run test:smoke`) はデプロイ済み環境に対して主要ユースケースを実行する。design.md にその対象を明記する。

## 4. 共通規律

- 最小の変更で解く。求められていない機能・抽象を足さない（CLAUDE.md の規律を継承する）。
- 重大な技術判断は ADR に残す（`.spec/adr/`）。
- 判断に迷ったらこの憲法 → requirements.md → design.md の優先順位で解決する。
