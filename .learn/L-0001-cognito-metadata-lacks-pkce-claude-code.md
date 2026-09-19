---
id: L-0001
date: 2026-09-19
task: なし（/sdd init の設計調査）
category: pitfall
status: new
promoted_to:
promoted_in:
---

# Cognito の OIDC メタデータは PKCE を広告せず、Claude Code の MCP OAuth が失敗する

## 事象

MCP サーバの認可サーバに Amazon Cognito を使う設計を検討中、Cognito の `/.well-known/openid-configuration` から `code_challenge_methods_supported` が削除されている（AWS re:Post 報告）と分かった。Claude Code は MCP 仕様に従いこの項目を必須とみなし、`Incompatible OIDC provider ...: does not support S256 code challenge method`（anthropics/claude-code #13275、not planned で close）または無言のトークン交換失敗（#35846、duplicate で close）になる。Cognito は RFC 8414 の `/.well-known/oauth-authorization-server` も提供せず、DCR（RFC 7591）にも非対応。

## 知見

Cognito を MCP の認可サーバにするなら、MCP サーバと同一オリジンに `/.well-known/oauth-protected-resource` と `/.well-known/oauth-authorization-server`（`code_challenge_methods_supported: ["S256"]` を明示）を自前で置き、401 の `WWW-Authenticate` を自分の PRM に向ける。クライアント登録は事前登録した client ID と固定コールバックポート（`claude mcp add --client-id ... --callback-port ...`）で行う。

## 適用先候補

- .spec/templates/design.md（認証節に「Cognito を使う場合の well-known 補完」を追記）
- CLAUDE.md
