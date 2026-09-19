---
id: L-0007
date: 2026-09-19
task: T-008, T-009, T-013
category: pitfall
status: new
promoted_to:
promoted_in:
---

# DynamoDB の落とし穴 3 点: contains は大小区別、予約語、ConditionalCheckFailedException.Item は unmarshall されない

## 事象

- REQ-010 の「大文字小文字を区別しない部分一致」を FilterExpression の `contains` で実装しようとしたが、`contains` は大小を区別する。
- `status` / `ttl` / `error` / `size` / `name` / `text` / `date` / `raw` は DynamoDB の予約語で、UpdateExpression に直接書くと `ValidationException` になる。
- `@aws-sdk/lib-dynamodb` の `UpdateCommand` に `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'` を付けても、例外の `Item` は AttributeValue 形式（`{ S: ... }`）のままで unmarshall されない。

## 知見

大小無視の部分一致は保存時に小文字化した属性（`subjectLower` / `fromLower` / `toLower`）を持たせ、入力も小文字化して `contains` する。式の属性名は常に `#別名` にする。条件失敗時の現在値が要るなら `GetCommand` で読み直す（競合時だけの 1 回なので単純な方を選ぶ）か、`@aws-sdk/util-dynamodb` の `unmarshall` を使う。

## 適用先候補

- .spec/templates/design.md（データモデル節の注意書き）
- CLAUDE.md
