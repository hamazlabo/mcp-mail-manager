---
id: L-0005
date: 2026-09-19
task: T-011
category: pitfall
status: new
promoted_to:
promoted_in:
---

# imapflow の messageMove / mailboxClose は EXPUNGE を発行し、list() はフォルダ名から SPECIAL-USE を推定する

## 事象

T-011 で imapflow 2.0 の実装を読んだところ、`messageMove()` は CAPABILITY に MOVE が無いサーバでは内部で `COPY` + `\Deleted` + `EXPUNGE` にフォールバックする。`mailboxClose()` は IMAP `CLOSE`（= 暗黙の expunge）を送る。また `list()` は SPECIAL-USE 非対応サーバでもフォルダ名（`Sent` / `Trash` 等）から `specialUse` を推定し、`specialUseSource: 'name'` を付けて返す。

## 知見

「EXPUNGE しない」要件（REQ-032）のあるコードでは、`capabilities.has('MOVE')` を自前で判定し、非対応時は `messageCopy()` + `messageFlagsAdd(['\\Deleted'])` を使う。フォルダを閉じる代わりに次の `mailboxOpen()` へ直接切り替え、接続終了は `logout()` だけにする。特殊フォルダは `specialUseSource === 'extension'`（サーバ属性由来）だけを採用し、無ければ設定値を使う。静的テストで `expunge` / `messageDelete` / `mailboxClose` の不在を検証する。

## 適用先候補

- .spec/templates/design.md（IMAP ラッパの設計注意）
- CLAUDE.md
