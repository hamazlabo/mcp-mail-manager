---
id: L-0003
date: 2026-09-19
task: なし（/sdd init の設計調査）
category: tech
status: new
promoted_to:
promoted_in:
---

# AgentCore Runtime で MCP をホストする際の制約と料金（2026-09 時点）

## 事象

MCP サーバのコンピュートに Amazon Bedrock AgentCore Runtime を採用するにあたり、公式ドキュメントと CDK リファレンスで次を確認した。

- コンテナは ARM64、`0.0.0.0:8000/mcp`、ステートレス Streamable HTTP。プラットフォームが `Mcp-Session-Id` を付与するので拒否しないこと。
- 直接コードデプロイ（zip）は Python 3.12 のみ。Node.js はコンテナ必須（CDK `AgentRuntimeArtifact.fromAsset(dir, { platform: LINUX_ARM64 })`）。x86 の GitHub Actions では QEMU が要る。
- インバウンド JWT 認可は `discoveryUrl`（`.../.well-known/openid-configuration` で終わる必要あり）+ `allowedClients`（`client_id` クレーム）。Cognito のアクセストークンには `aud` が無いので `allowedAudience` は使わない。
- 未認証の 401 は AgentCore 自身の PRM を指し、その `authorization_servers` は IdP の issuer になる（Cognito では L-0001 の問題が起きる）。
- 料金（Runtime microVMs v2、消費ベース）: 0.1276 USD / vCPU-h、0.0169 USD / GB-h。CPU はアクティブ時のみ、アイドルメモリは 120 秒で回収。最小 128 MB。
- CDK L2 `aws_bedrockagentcore.Runtime` は aws-cdk-lib 2.270 で stable。デプロイロールに `iam:CreateServiceLinkedRole` が必要。
- 東京リージョン（ap-northeast-1）で利用可能。

## 知見

Node.js の MCP を AgentCore Runtime に載せるなら「ARM64 コンテナ + JWT 認可 + 前段の well-known 提供」をセットで設計する。コスト試算は vCPU-h と GB-h で行い、idle timeout を短くしてメモリ課金を抑える。

## 適用先候補

- .spec/templates/design.md（コンピュート選択肢に AgentCore Runtime を追加）
- .spec/constitution.md（人間へ提案: コンピュートの優先順位に AgentCore Runtime を位置付ける）
