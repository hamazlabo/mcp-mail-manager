---
id: L-0024
date: 2026-10-31
task: T-033
category: pitfall
status: new
promoted_to:
promoted_in:
---

# 呼出記録型のフェイクは宣言した引数しか記録しないので、新しい引数のテストが実装後も Red のままになる

## 事象

T-033 で `mailboxOpen(folder, { readOnly: true })` を検証するテストを書いた。実装後も `expected [['INBOX'], …] to deeply equal [['INBOX', { readOnly: true }], …]` で失敗し続けた。`test/unit/core/imap.test.ts` の `fakeClient.mailboxOpen(path)` が `record('mailboxOpen', path)` と第 1 引数だけを記録していたため、第 2 引数が記録から落ちていた。Red の段階で失敗理由の差（「実装が無い」か「フェイクが落としている」か）を見分けられなかった。

## 知見

呼出を記録するフェイクは `(...args) => record(name, ...args)` のように受け取った引数をすべて記録する。既存のメソッドに引数を足すテストを書くときは、Red の前にフェイクがその引数を記録できるかを確認する。

## 適用先候補

- .claude/skills/sdd/develop.md（Red の確認: 失敗理由が「未実装」であることを確かめる）
- CLAUDE.md
