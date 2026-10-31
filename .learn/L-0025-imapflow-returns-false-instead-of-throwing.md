---
id: L-0025
date: 2026-10-31
task: T-033, T-035
category: pitfall
status: promoted
promoted_to: .spec/design.md
promoted_in: v1
---

# imapflow は STATUS / STORE の失敗を例外ではなく false で返し、読み取り専用のフォルダへの STORE は黙って捨てる

## 事象

T-033〜T-035 のレビュー（imapflow 2.0.5 のソースを確認）で次が分かった。

- `status()` は NotFound 以外のエラーを握りつぶして `false` を返す（commands/status.js）。型定義は `Promise<StatusObject>` で、`false` の可能性が表れない。そのため `status.messages ?? 0` と書くと、失敗が「0 件」として出力される。
- `messageFlagsAdd` / `messageFlagsRemove`（STORE）は、`PERMANENTFLAGS` に無いフラグを送らずに `false` を返す。`EXAMINE` 後のフォルダは `PERMANENTFLAGS ()` なので、STORE は一切送られない。サーバの NO も握りつぶして `false` を返す。
- `EXAMINE` で開いても COPY は禁止されない（RFC 3501）。

ADR-0007 の初版は「読み取り専用のフォルダではサーバが STORE を拒否するので、誤りが失敗として現れる」と書いていたが、誤りだった。

## 知見

imapflow の戻り値 `false` は失敗の合図として扱い、結果を使う箇所では `if (!result) throw` で検査する。「読み取り専用で開けば誤った書込みが止まる」とは考えない。書込みをしないことはコード側（呼ばないこと）とテストで保証する。

## 適用先候補

- CLAUDE.md（imapflow の戻り値の扱い）
- .spec/templates/design.md（IMAP ラッパの設計注意）
- src/core/imap.ts の `setFlags`（STORE の false を無視している。同期以外の経路での影響は別途判断）
