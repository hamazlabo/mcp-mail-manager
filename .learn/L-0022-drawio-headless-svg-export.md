---
id: L-0022
date: 2026-09-19
task: なし（README の構成図）
category: tech
status: new
promoted_to:
promoted_in:
---

# draw.io の SVG を GitHub の README に埋め込むには、ラベルを HTML にしない（whiteSpace=wrap を使わない）

## 事象

構成図を draw.io デスクトップ版（`drawio --export --format svg --embed-diagram`、xvfb でヘッドレス実行）で書き出したところ、スタイルに `whiteSpace=wrap` を付けたラベルが `<foreignObject>`（HTML）になり、GitHub の README では「Text is not SVG - cannot display」と表示される状態だった。`html=0` を付けていても `whiteSpace=wrap` があると HTML ラベルになる。改行は `\n` をそのまま使えば `<text>` 要素で描画される。AWS アイコンは `shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.<name>` で、同梱の名前は app.asar を `mxgraph\.aws4\.[a-z_0-9]*` で grep すると分かる（Bedrock / EventBridge Scheduler / CloudFront Functions の専用アイコンは 31.4 時点で無い）。

## 知見

GitHub に載せる draw.io の SVG は、全セルで `html=0` かつ `whiteSpace=wrap` 無し、改行は `\n`。書き出し後に `grep -c '<foreignObject'` が 0 であることを確認する。`--embed-diagram` を付けると SVG 自体を draw.io で再編集できる。

## 適用先候補

- .claude/skills/sdd/init.md（design.md の構成図を作る手順）
- CLAUDE.md
