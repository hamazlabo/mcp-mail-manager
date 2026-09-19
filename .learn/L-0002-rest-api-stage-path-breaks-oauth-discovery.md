---
id: L-0002
date: 2026-09-19
task: なし（/sdd init の設計調査）
category: pitfall
status: new
promoted_to:
promoted_in:
---

# API Gateway REST API のステージパスは OAuth メタデータの発見 URL を壊す

## 事象

Lambda を使わずに well-known を返すため REST API の MOCK 統合を検討したが、REST API の URL には必ず `/<stage>/` が付く。RFC 8414 / MCP 仕様では issuer にパスがあると `https://host/.well-known/oauth-authorization-server/<stage>` のように well-known をパスの前に挿入して探すため、REST API では 404 になる。Claude 側はパスを落として探すという報告（anthropics/claude-ai-mcp #367）もある。HTTP API は `$default` ステージでパス無しにできるが MOCK 統合が無い。

## 知見

OAuth の well-known を API Gateway で返すなら、パス無しの URL が必要（HTTP API の `$default` + Lambda、独自ドメイン、または CloudFront + CloudFront Functions）。REST API の MOCK 統合は独自ドメイン無しでは使えない。

## 適用先候補

- .spec/templates/design.md
- .claude/skills/sdd/init.md（ステップ 3 の提案時に「URL のパス制約」を確認する観点）
