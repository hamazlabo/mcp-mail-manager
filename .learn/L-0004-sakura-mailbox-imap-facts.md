---
id: L-0004
date: 2026-09-19
task: なし（/sdd init の仕様確認）
category: domain
status: new
promoted_to:
promoted_in:
---

# さくらのメールボックス（Courier-IMAP）の接続仕様と機能

## 事象

独自ドメインのホスト名で IMAP に接続すると Cloudflare の IP に解決され到達できなかった。MX レコード（`<初期ドメイン>.sakura.ne.jp`）に接続したところ Courier-IMAP が応答し、ローカル部だけのユーザ名では `Login failed.`、メールアドレス全体でログインできた。CAPABILITY は `IMAP4rev1 UIDPLUS CHILDREN NAMESPACE THREAD=ORDEREDSUBJECT THREAD=REFERENCES SORT QUOTA IDLE AUTH=PLAIN ACL ACL2=UNION`（ログイン前後で同じ）。フォルダは `INBOX.Sent` / `INBOX.Trash` / `INBOX.Draft` / `INBOX.spam`（区切り `.`）。SMTP は 587 STARTTLS と 465 SMTPS の両方で AUTH が通る（PLAIN / LOGIN / CRAM-MD5、SIZE 200 MB）。

## 知見

さくらのメールボックスは「ホスト = MX の初期ドメイン、ユーザ名 = メールアドレス全体、MOVE / SPECIAL-USE / CONDSTORE 無し、UIDPLUS あり」を前提に実装する。移動は COPY + \Deleted（COPYUID で新 UID 取得）で、特殊フォルダ名は固定値で持つ。

## 適用先候補

- .spec/design.md（反映済み）
- README.md（Secrets の設定例: ホストとユーザ名の書き方）

## 追記（2026-09-19）

設定はカスタムドメインだけを持ち、接続先ホストは MX レコード（優先度最小）から実行時に導出する方式を採用した（design.md 5 章）。さくらは MX = 初期ドメイン = IMAP/SMTP ホストなので成立する。Gmail のように MX と IMAP ホストが異なるプロバイダ向けに `imapHost` / `smtpHost` の明示指定を残す。
