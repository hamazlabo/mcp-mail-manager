---
id: L-0016
date: 2026-09-19
task: T-025, T-026, T-027
category: tech
status: new
promoted_to:
promoted_in:
---

# AgentCore Runtime L2（aws-cdk-lib 2.270）の実 API と、CDK assertions / Cognito の癖

## 事象

- `agentcore.Runtime({ runtimeName, agentRuntimeArtifact: AgentRuntimeArtifact.fromEcrRepository(repo, tag), protocolConfiguration: ProtocolType.MCP, networkConfiguration: RuntimeNetworkConfiguration.usingPublicNetwork(), authorizerConfiguration: RuntimeAuthorizerConfiguration.usingCognito(userPool, [client]), environmentVariables, lifecycleConfiguration: { idleRuntimeSessionTimeout } })`。設計時に想定した `usingJWT(url, clients)` ではなく `usingCognito` が discovery URL を組み立てる。実行ロールは `runtime.role` で取れ、`fromEcrRepository` が ECR pull を付与する。
- `AwsCustomResource` の `logging: Logging.withDataHidden()` は Props ではなく `AwsSdkCall` 側。Secrets の値は `secretValueFromJson('x').unsafeUnwrap()` で `{{resolve:secretsmanager:...}}` の動的参照になりテンプレートに平文は入らない。
- Cognito の `signInAliases: { email: true }` だけだと Username が email 形式に制限され、固定ユーザ名（`smoke`）が作れない。逆に `{ username: true, email: true }`（email をエイリアス）にすると `AdminCreateUser` の Username にメールアドレス形式は使えない（`Username cannot be of email format`）。開発者ユーザは `developer` + email 属性で作る。新しい Managed Login（`ManagedLoginVersion.NEWER_MANAGED_LOGIN`）は `CfnManagedLoginBranding` が無いとログイン画面が出ない。
- CDK assertions の `Match.arrayWith` は要素順も見る。スタックが育つと `Template.fromStack` に 5 秒超かかるので `beforeAll(..., 60_000)`。

## 知見

AgentCore の JWT 認可は `usingCognito` を使い、ロールは `runtime.role` に grant する。Cognito でユーザ名ログインが要るなら `username: true` も残す。CDK テストは 1 ファイル 1 synth。

## 適用先候補

- .spec/templates/design.md（AgentCore を使う設計の雛形）
- .claude/skills/sdd/develop.md
