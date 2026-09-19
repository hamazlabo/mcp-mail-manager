---
id: L-0008
date: 2026-09-19
task: T-019
category: tech
status: new
promoted_to:
promoted_in:
---

# MCP SDK 1.30 のステートレス Streamable HTTP の癖

## 事象

T-019 でツール未登録の `McpServer` に `tools/list` を送ると `-32601 Method not found` が返った。`McpServer` は最初の `registerTool` で初めて `tools/*` ハンドラを設定する（`setToolRequestHandlers` は private）。また Node 版 `StreamableHTTPServerTransport` は内部で Hono の `getRequestListener` により Web 標準 Request/Response に変換する。`parsedBody` を渡せば `req.json()` は呼ばれないので本文を先に読み切ってよい。`sessionIdGenerator: undefined`（ステートレス）では `Mcp-Session-Id` の検証は完全にスキップされる（AgentCore が付与するヘッダを拒否しない）。ステートレスは「1 リクエスト = 1 transport」が必須で、`McpServer.close()` が transport も閉じる。

## 知見

骨格テストは最低 1 ツールを登録して `tools/list` を検証する。ステートレス運用ではリクエストごとに `McpServer` + transport を生成し、`finally` で `server.close()` だけ呼ぶ。

## 適用先候補

- .spec/templates/design.md（MCP サーバ節）
