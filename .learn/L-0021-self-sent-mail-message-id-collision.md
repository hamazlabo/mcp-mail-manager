---
id: L-0021
date: 2026-09-19
task: T-016（設計 4 章）
category: domain
status: new
promoted_to:
promoted_in:
---

# 自分宛に送ったメールは INBOX と Sent で Message-ID が同じため、id = sha256(Message-ID) の設計では 1 レコードに畳まれる

## 事象

prod で `send_message` / 予約送信を自分宛に行ったところ、IMAP の INBOX（受信コピー、UID 5・6）と INBOX.Sent（APPEND したコピー）に同じ Message-ID のメッセージが入った。同期はどちらも `id = sha256(Message-ID)` で PutItem するため、後に処理した INBOX.Sent が INBOX の登録を上書きし、DynamoDB では INBOX.Sent のレコードだけが残る（照合ログ: INBOX `known: 4, total: 6`）。検索で「INBOX の自分宛メール」は見つからず、INBOX.Sent として出る。データの欠落や重複は無く、フォルダ移動時に同じアイテムを更新できる利点（design.md 4 章）とのトレードオフ。メーリングリストの自己コピーなど、複数フォルダに同一 Message-ID がある場合も同様。

## 知見

1 メッセージ 1 レコード（Message-ID キー）の設計では「同一 Message-ID が複数フォルダに存在する」ケースは最後に同期したフォルダが勝つ。個人利用では自分宛送信が主な該当ケースで、Sent 側が残るのは許容範囲。厳密にしたい場合は id を `sha256(Message-ID + folder)` にして移動を「削除 + 追加」で扱う設計に変える（ADR 起票が必要）。同期の照合ログ `known < total` はこの状態のサインとして使える。

## 追記（2026-09-19）

ユーザ判断で ADR-0006（id = sha256(Message-ID + folder)、移動は旧レコード削除 + 新レコード作成）を採択し、実装した。

## 適用先候補

- .spec/design.md 4 章（既知の制約として追記）
- .spec/templates/design.md（データモデルの検討観点）
