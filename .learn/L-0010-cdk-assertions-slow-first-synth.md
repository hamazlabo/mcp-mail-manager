---
id: L-0010
date: 2026-09-19
task: T-014
category: pitfall
status: new
promoted_to:
promoted_in:
---

# autoDeleteObjects を含むスタックの初回 Template.fromStack は 5〜10 秒かかり vitest の既定タイムアウトを超える

## 事象

T-014 の CDK assertions で、`autoDeleteObjects: true` のバケットを持つスタックの最初の `Template.fromStack` がカスタムリソースのアセットステージングで 5〜10 秒かかり、vitest の既定 `testTimeout`（5 秒）で最初のテストがタイムアウトした。

## 知見

infra のテストはファイル内で `beforeAll(() => { template = Template.fromStack(...) }, 60_000)` により一度だけ synth し、各テストは同じ `Template` を使う。後続の CDK テストも同じ構造にする。

## 適用先候補

- .claude/skills/sdd/develop.md（CDK タスクのテスト構造の注意）
- .spec/templates/task.md
