---
id: L-0026
date: 2026-10-31
task: T-037
category: pitfall
status: new
promoted_to:
promoted_in:
---

# DynamoDB の KeyCondition と Filter は ExpressionAttributeValues を共有するので、動的に組み立てるとプレースホルダが上書きされる

## 事象

`buildQuery` は日時範囲を `GSI2SK BETWEEN :from AND :to`、差出人・宛先を `contains(fromLower, :from)` / `contains(toLower, :to)` で組み立てていた。値を 1 つのオブジェクトに入れるため、`from` を指定すると日時の下限が差出人の文字列で上書きされる。実 DynamoDB（dev）では `ValidationException: The BETWEEN operator requires upper bound to be greater than or equal to lower bound` になった。`to` を指定すると上限が置き換わり、`before` が効かなくなった。T-008 からのユニットテストは `ExpressionAttributeValues` を `toMatchObject` で確かめていて、壊れた値（`':from': 'alice'`）を正としていた。prod の `search_messages` は、差出人を指定すると毎回失敗していた。

## 知見

KeyCondition と Filter のプレースホルダは名前空間を分ける（範囲は `:since` / `:before` など、意味の異なる名前にする）。式を組み立てるコードのテストでは、値の一覧を固定するのではなく、式中のプレースホルダを値に解決して「どの条件がどの値を見るか」を確かめる。可能なら実テーブル（dev）に読み取り専用の Query を 1 回投げて確かめる。

## 適用先候補

- .spec/templates/design.md（データモデル: 動的なクエリ組立の注意）
- CLAUDE.md
