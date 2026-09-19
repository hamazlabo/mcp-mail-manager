---
id: L-0020
date: 2026-09-19
task: T-029
category: pitfall
status: new
promoted_to:
promoted_in:
---

# Cognito は RFC 8707 の resource パラメータを検証する。未登録の resource は token 交換で invalid_grant になる

## 事象

claude.ai のカスタムコネクタで Cognito のログインは通るのに「認証に失敗しました」になった。CloudTrail の `Token_POST`（`python-httpx`、Anthropic の IP）は `resource=https://<façade>/mcp` 付きで 400。smoke ユーザで認可コードフローを再現すると、`resource` を authorize に付けた場合だけ token 交換が `{"error":"invalid_grant"}`（token 側だけに付けても影響なし）。Cognito のリソースサーバに McpUrl を識別子として登録すると成功し、アクセストークンに `aud` = McpUrl と `client_id` が入り、AgentCore の JWT 認可も通った。ADR-0004 の「Cognito は resource を無視する」は誤りだった。

## 知見

MCP の認可サーバに Cognito を使うなら、MCP サーバの URL（PRM の `resource` と同じ値）を識別子にした `UserPoolResourceServer` を必ず登録する（スコープは 1 つ以上、クライアントがそのスコープを要求する必要はない）。認可コードフローの検証は `.well-known` と PKCE だけでなく、`resource` 付きで実際に token 交換まで通す。CloudTrail の `Token_POST` はエラー種別を残さないので、再現スクリプト（hosted UI に POST → code → token）で切り分ける。

## 適用先候補

- .spec/adr/0004（反映済み）、.spec/design.md（反映済み）
- .spec/templates/design.md（Cognito を認可サーバにする場合の必須項目）
- test/smoke（`resource` 付きの認可コードフローを smoke に含めるか検討）
