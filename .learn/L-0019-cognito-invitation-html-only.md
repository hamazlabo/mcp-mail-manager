---
id: L-0019
date: 2026-09-19
task: T-029
category: domain
status: new
promoted_to:
promoted_in:
---

# Cognito の招待メール（Your temporary password）は text/html パートのみで、HTML を表示しないウェブメールでは本文が空に見える

## 事象

`AdminCreateUser`（`DesiredDeliveryMediums: EMAIL`、既定テンプレート）で送られた招待メールを、さくらのウェブメールで開くと本文が無いように見えた。同期済みの生メッセージ（S3）を確認すると、`multipart/alternative` の中に `text/html; charset=utf-8`（7bit、約 70 バイト）のパートが 1 つだけあり、`text/plain` パートが無い。本文自体は `Your username is developer and temporary password is ...` の 1 行で存在する。

## 知見

Cognito の送信メールは HTML パートのみ（テンプレートをプレーンテキストにしても MIME 種別は変わらない）。受信側で HTML 表示を有効にするか、ソース表示 / 同期済み生メッセージで読む。README に読み方を書いておく。仮パスワードは 7 日で失効し、`--message-action RESEND` で再送できる。

## 適用先候補

- README.md（反映済み）
- .spec/templates/design.md（Cognito を使う設計の注意）
