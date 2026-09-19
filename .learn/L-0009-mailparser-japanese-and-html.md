---
id: L-0009
date: 2026-09-19
task: T-006
category: tech
status: new
promoted_to:
promoted_in:
---

# mailparser: ISO-2022-JP は encoding-japanese、html-only は自動でテキスト化される

## 事象

T-006 のフィクスチャ作成で `iconv-lite` は ISO-2022-JP を扱えなかった。mailparser 3.x は日本語を依存の `encoding-japanese` で処理しており、フィクスチャ生成も `Encoding.convert(..., { to: 'JIS' })` で行う必要があった。text/plain が無いメールは mailparser 自身が html-to-text で `text` を生成する（`skipHtmlToText` で抑止可）。見出し（h1 等）は大文字化される。宛先の `text` は表示名を引用符で囲むことがあるため、`value` から `Name <addr>` を自分で整形した。

## 知見

日本語メールのテスト用バイト列は `encoding-japanese` で作る。HTML のみのメールは追加の変換コードを書かず mailparser の `text` を使う。宛先文字列は `value[].name / address` から組み立てる。

## 適用先候補

- .spec/templates/design.md（MIME 解析節）
