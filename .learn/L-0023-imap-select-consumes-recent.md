---
id: L-0023
date: 2026-10-31
task: なし（/sdd init の仕様確認）
category: domain
status: new
promoted_to:
promoted_in:
---

# IMAP の SELECT は `\Recent` を消費する。読むだけの処理は EXAMINE、件数確認は STATUS を使う

## 事象

「同期がサーバ側にフラグを立てている」という懸念を調べた。本文は imapflow の `fetchAll({ source: true })` で取得しており、これは `BODY.PEEK[]` に変換されるので `\Seen` は付いていなかった。一方、`mailboxOpen(path)` は `SELECT`（読み書き）で開くので、RFC 3501 の規定どおりそのフォルダの全メッセージの `\Recent` を消費していた（Courier は Maildir の `new/` から `cur/` への移動で表現する）。dev と prod の同期ジョブは同じメールボックスを開いている。Courier が `EXAMINE` で `\Recent` を保つかは、公開情報では確認できなかった。

## 知見

メールサーバの状態を変えたくない処理は、`mailboxOpen(path, { readOnly: true })`（= `EXAMINE`）で開く。STORE / COPY が要る整理操作だけを `SELECT` にする。実機で状態を確かめるときは、フォルダを開かない `STATUS (MESSAGES RECENT UNSEEN)`（imapflow `status(path, { recent: true, ... })`）を使い、確認作業そのものが状態を変えないようにする。

## 適用先候補

- .spec/design.md 3.4（反映済み: ADR-0007）
- .spec/templates/design.md（IMAP ラッパの設計注意: 開くモード）
