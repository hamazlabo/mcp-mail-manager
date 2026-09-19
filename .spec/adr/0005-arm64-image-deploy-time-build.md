# ADR-0005: MCP コンテナの ARM64 イメージを deploy-time-build（CodeBuild）でデプロイ時にビルドする

- **日付**: 2026-09-19
- **ステータス**: Accepted
- **関連要件**: REQ-050, NFR-001, NFR-003
- **関連憲法条項**: 1. AWS 前提（IaC で管理）、2. サーバレス優先（従量課金）

## 文脈 (Context)

AgentCore Runtime は ARM64 コンテナを要求する（ADR-0001）。設計当初は CDK の `AgentRuntimeArtifact.fromAsset(dir, { platform: LINUX_ARM64 })` を使う予定だったが、これは `cdk deploy` を実行するホストで `docker build --platform linux/arm64` を行うため、x86 のローカル環境と GitHub Actions（ubuntu-latest）では QEMU（`docker/setup-qemu-action`、`tonistiigi/binfmt`）と buildx が必要になる。本開発環境は x86_64 で binfmt も buildx も無く、エミュレーションビルドは遅い。ユーザから「ARM のイメージビルドに deploy-time-build が使えれば採用する」と指示があった。

`deploy-time-build`（tmokmss）は `@cdklabs/deploy-time-build` に移行済み（0.1.x、`aws-cdk-lib ^2.38` 対応）。`ContainerImageBuild` はビルドコンテキストを S3 アセットとして上げ、デプロイ時に CodeBuild（`platform: LINUX_ARM64` なら ARM ランナー）で `docker build` と ECR push を行い、`repository` / `imageTag` / `imageUri` を返す。CDK 2.270 の `AgentRuntimeArtifact.fromEcrRepository(repository, tag)` にそのまま渡せることを確認した。

## 決定 (Decision)

MCP コンテナのイメージは `@cdklabs/deploy-time-build` の `ContainerImageBuild`（`platform: Platform.LINUX_ARM64`、コンテキスト = リポジトリルート、`file: docker/Dockerfile`）でデプロイ時に CodeBuild 上でネイティブビルドし、`AgentRuntimeArtifact.fromEcrRepository(image.repository, image.imageTag)` で AgentCore Runtime に渡す。ローカル・CI に QEMU / buildx を導入しない。`npm run build`（esbuild）で `dist/mcp/main.js` を生成してから `cdk synth` / `cdk deploy` を実行する契約とし、Dockerfile はそれをコピーするだけにする。

## 検討した選択肢

| 選択肢 | 利点 | 欠点 | コスト影響 |
|--------|------|------|------------|
| A: `@cdklabs/deploy-time-build` で CodeBuild ARM ビルド（採用） | QEMU 不要でネイティブ速度。ローカルの `cdk deploy` と CI で同じ経路。Docker デーモンすら不要 | CodeBuild プロジェクトと custom resource 用 Lambda が増える。デプロイ時間が数分伸びる | CodeBuild arm1.small 約 0.0034 USD / 分。月 10 デプロイ × 3 分 ≒ 0.10 USD。アイドル時 0 |
| B: `AgentRuntimeArtifact.fromAsset` + QEMU（当初案） | 構成要素が最小 | x86 ホストで binfmt / buildx が必須。エミュレーションで遅い。ローカル環境に root 権限の設定が要る | 0 USD |
| C: GitHub Actions の ARM ランナーで docker build / push し、CDK は `fromEcrRepository` を参照 | ネイティブ速度 | ローカルからの `cdk deploy` が成立しない。イメージのライフサイクル管理が CDK の外に出る | 0 USD（public リポジトリ） |

## 結果 (Consequences)

- 良い点: 開発機・CI ともに Docker のアーキテクチャ設定から解放される。`cdk deploy` 一発で ARM64 イメージが出来上がる。
- 悪い点 / トレードオフ: デプロイに CodeBuild 待ち（2〜4 分）が加わる。ビルドコンテキストのハッシュが変わった時だけ再ビルドされるため、`.dockerignore` の管理が必要。CI/CD の 3 ワークフローに `npm run build` ステップを追加する（QEMU ステップは不要になる）。
- 憲法との関係: 準拠（IaC 内で完結し、ビルド時のみ課金）。ADR-0001 の「CI は QEMU を要する」という欠点は本 ADR で解消される。
