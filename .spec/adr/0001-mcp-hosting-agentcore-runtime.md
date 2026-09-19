# ADR-0001: MCP サーバを Amazon Bedrock AgentCore Runtime でホストし、CloudFront の façade を前段に置く

- **日付**: 2026-09-19
- **ステータス**: Proposed
- **関連要件**: REQ-050, REQ-051, NFR-001, NFR-005
- **関連憲法条項**: 2. サーバレス優先（コンピュート: Lambda → Fargate → EC2、API: HTTP API 優先）

## 文脈 (Context)

MCP の Streamable HTTP トランスポートを AWS 上でサーバレスに提供する必要がある。憲法はコンピュートを Lambda 優先としているが、ユーザは MCP 部分のコンピュートとして **Amazon Bedrock AgentCore Runtime** の利用を指定した。AgentCore Runtime は MCP プロトコルを一級でサポートし（コンテナを `0.0.0.0:8000/mcp` で待ち受け、ステートレス Streamable HTTP を推奨、`Mcp-Session-Id` をプラットフォームが付与）、インバウンド認証として OIDC/JWT（Cognito 等）の検証を内蔵する。料金は従量課金（vCPU 秒とメモリ GB 秒、アイドル時のメモリは 120 秒で自動回収）でアイドルコストはゼロに近い。CDK には L2 コンストラクト `aws_bedrockagentcore.Runtime` があり、`AgentRuntimeArtifact.fromAsset` で Dockerfile からデプロイできる。Node.js の直接コードデプロイは未対応のため ARM64 コンテナで配布する。

一方、AgentCore Runtime の呼出 URL は `https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<ARN>/invocations?qualifier=DEFAULT` で、未認証時の 401 は AgentCore 自身の Protected Resource Metadata を指し、その `authorization_servers` は Cognito の issuer になる。Cognito は RFC 8414 メタデータを提供せず、OIDC メタデータにも `code_challenge_methods_supported` が含まれないため、Claude 系クライアントが Cognito を直接辿ると接続に失敗する報告がある（awslabs/agentcore-samples #1056、kane.mx の façade 事例）。

## 決定 (Decision)

1. MCP サーバ本体（ツール実装）は AgentCore Runtime（プロトコル MCP、PUBLIC ネットワーク、JWT 認証 = Cognito の discovery URL + allowedClients）でホストする。イメージは CDK の `AgentRuntimeArtifact.fromAsset(dir, { platform: LINUX_ARM64 })` でビルド・配布する。
2. 前段に **CloudFront の façade** を置く。役割は (a) `/.well-known/oauth-protected-resource` と `/.well-known/oauth-authorization-server` を CloudFront Function（viewer-request）が静的 JSON で返す（後者は Cognito のエンドポイントを転記し `code_challenge_methods_supported: ["S256"]` を明示する）、(b) `POST /mcp` を URI 書換で AgentCore の呼出 URL へ転送し、CloudFront Function（viewer-response）が 401 応答の `WWW-Authenticate` を façade の PRM を指すよう上書きする。Lambda・S3 は使わない。ユーザが Claude に登録する URL は façade の `/mcp` である。
3. 同期ジョブと予約送信は引き続き Lambda（ADR-0002 / ADR-0003）。

## 検討した選択肢

| 選択肢 | 利点 | 欠点 | コスト影響 |
|--------|------|------|------------|
| A: AgentCore Runtime + CloudFront façade（採用） | MCP ネイティブ対応、JWT 検証内蔵、セッション分離（microVM）。ユーザ指定。façade はランタイムを持たず保守対象が増えない | Lambda より構成要素が多い（ECR イメージ、CloudFront）。コンテナビルドに ARM64（QEMU）が要る。憲法の Lambda 優先に対する例外 | Runtime: 想定 200 呼出 / 日で約 0.6 USD / 月。façade: 無料枠内 |
| B: API Gateway HTTP API + Lambda（MCP 本体も Lambda、ステートレス JSON 応答） | 憲法準拠、最小構成、Lambda 無料枠内 | ユーザが不採用（AgentCore を指定） | 0.01 USD |
| C: AgentCore Runtime を直接公開（façade なし） | 構成が最小 | Claude Code は Cognito のメタデータに PKCE 記載が無いため接続に失敗する（anthropics/claude-code #13275 / #35846）。URL が長く ARN を含む | 0 USD |
| D: AgentCore Gateway を前段に置く | ポリシー・ガードレール等の統制機能 | Gateway も RFC 8414 / DCR を提供せず同じ問題が残る（#1056）。追加料金 | 0.005 USD / 1,000 呼出 |
| E: façade を API Gateway HTTP API + 小さな Lambda で作る | 一般的で追いやすい | ランタイム保守の対象が 1 つ増える（ユーザが回避を希望） | 0.01 USD |
| F: façade を API Gateway REST API の MOCK 統合で作る | Lambda 不要 | REST API の URL にステージパスが付き、OAuth メタデータの発見 URL が組み替えられて失敗する。独自ドメインが必須 | 0.01 USD + ドメイン |
| G: クライアント側に `mcp-remote` を挟む（AWS ブログの方式） | サーバ側追加なし | Claude に stdio 経由で登録する必要があり claude.ai（Web）で使えない。Cognito の PKCE 記載欠落を許容するか未検証 | 0 USD |

## 結果 (Consequences)

- 良い点: MCP サーバはプレーンな Node.js HTTP サーバとして書け、ローカルでも同じコンテナで動作確認できる。認証はプラットフォームが検証するためアプリ側の JWT 検証コードが不要。
- 悪い点 / トレードオフ: façade の分だけ経路が増える（レイテンシ +数十 ms）。CloudFront のデプロイに数分かかる。CI は ARM64 イメージのビルドに `docker/setup-qemu-action` を要する（→ [ADR-0005](0005-arm64-image-deploy-time-build.md) で CodeBuild ビルドに変更し解消）。AgentCore の microVM コールドスタート（数秒）が初回応答に乗る。
- 憲法との関係: **例外**。コンピュートの優先順位（Lambda 優先）に対し、ユーザ指定により AgentCore Runtime を採用する。従量課金でアイドルコストはほぼゼロであり、憲法 2 章の趣旨（常時起動を避ける）は満たす。
