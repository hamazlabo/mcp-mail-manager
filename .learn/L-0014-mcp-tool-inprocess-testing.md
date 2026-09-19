---
id: L-0014
date: 2026-09-19
task: T-020, T-021, T-023
category: tech
status: new
promoted_to:
promoted_in:
---

# MCP ツールは InMemoryTransport でプロセス内テストできる。AWS SDK v3 の例外はモデル固有の Message も要る

## 事象

- ツールのユニットテストで HTTP を立てず、`@modelcontextprotocol/sdk/inMemory.js` の `InMemoryTransport.createLinkedPair()` で `McpServer` と `Client` を直結し `client.callTool({ name, arguments })` で呼んだ。戻り値は `CallToolResult` にキャストして `isError` / `content[0].text` を見る。3 つのテストファイルで共通ヘルパ（`test/unit/mcp/helpers.ts`）にまとめた。
- `aws-sdk-client-mock` の `rejects` に `new ResourceNotFoundException({ message })` を渡すと型エラーになる。SDK v3 の例外クラスはモデル固有の `Message` プロパティも必須（`ExceptionOptionType`）で、`{ message, Message, $metadata: {} }` で生成する。
- `MailStore.queryMessages` が内部キー（PK/SK/GSI*）を剥がす設計にしたため、GSI Query の継続キー（`ExclusiveStartKey`）は返した最後の項目から `keys.*` で復元する必要があった。

## 知見

ツールの検証は InMemoryTransport で行い、HTTP 経由のテストは骨格（T-019）と正常性テストに限る。AWS SDK の例外は `{ message, Message, $metadata }` で作る。キーを剥がすストアはページング用にキー再構築関数を `keys` に持たせる。

## 適用先候補

- .claude/skills/sdd/develop.md（テストの書き方の注意）
- .spec/templates/design.md
