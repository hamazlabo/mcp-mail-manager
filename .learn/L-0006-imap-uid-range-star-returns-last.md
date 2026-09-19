---
id: L-0006
date: 2026-09-19
task: T-011
category: domain
status: new
promoted_to:
promoted_in:
---

# IMAP の `n:*` は n が最大 UID を超えると最後の 1 通を返す

## 事象

差分同期で `UID FETCH <lastUid+1>:*` / `UID SEARCH UID <lastUid+1>:*` を使う設計にしたが、RFC 3501 の規定により `*` は「現在の最大 UID」を意味し、`n > 最大 UID` のときは範囲が `最大UID:最大UID` に丸められて最後の 1 通が返る。新着が無い同期のたびに最後のメッセージを再取込してしまう。

## 知見

`n:*` の結果は必ず `uid >= n` でフィルタする。ImapSession の `searchUids({ uidFrom })` / `fetchFlags(folder, uidFrom)` はこのフィルタを内蔵している。

## 適用先候補

- .spec/design.md 3.2（同期アルゴリズムに注記済みの前提として）
- .spec/specify.md 用語集
