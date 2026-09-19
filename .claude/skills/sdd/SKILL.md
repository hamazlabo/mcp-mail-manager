---
name: sdd
description: Spec 駆動開発 (SDD)。`/sdd init <開発要望>` で .spec/ 配下に specify → requirements → design → task を対話的に作成し、`/sdd develop [タスクID]` で task.md に沿って TDD で実装する。`/sdd learn <知見>` で .learn/ に知見を記録し、`/sdd upgrade` で蓄積した知見をステアリングに昇格してコンテキストをバージョンアップする。
argument-hint: "init <開発要望> | develop [T-xxx] | learn <知見> | upgrade"
disable-model-invocation: true
---

# /sdd — Spec 駆動開発

引数: `$ARGUMENTS`

最初の単語をサブコマンドとして解釈する。

| サブコマンド | 動作 | 手順書 |
|--------------|------|--------|
| `init <開発要望>` | 憲法に基づき spec 一式を対話的に作成する | [init.md](init.md) |
| `develop [T-xxx]` | task.md の未完了タスクを TDD で実装する | [develop.md](develop.md) |
| `learn <知見>` | 実装中に得た知見を `.learn/` に 1 件記録する | [learn.md](learn.md) |
| `upgrade` | 未昇格の知見をレビューし、ステアリングへ反映してコンテキストをバージョンアップする | [upgrade.md](upgrade.md) |

サブコマンドが上記以外、または空の場合は使い方を示して停止する。

## 共通ルール

- ドキュメントの置き場所は固定:

  ```
  .spec/
    constitution.md      # 人間が管理。エージェントは編集しない
    specify.md           # 上位ビジョン
    requirements.md      # EARS 構文の要件定義
    design.md            # 技術仕様
    task.md              # 実装計画
    adr/NNNN-<slug>.md   # Architecture Decision Record
    templates/           # 各ドキュメントの雛形
  .learn/
    L-NNNN-<slug>.md     # 実装中に得た知見（1 件 1 ファイル）
    CHANGELOG.md         # コンテキストのバージョン履歴（/sdd upgrade が更新）
  ```

- 作業開始時に必ず `.spec/constitution.md` を読む。存在しなければ「憲法が未作成」と伝えて停止する。
- 憲法と矛盾する判断は勝手に選ばず、ADR を起票してユーザに承認を求める。
- 各ドキュメントは `.spec/templates/` の雛形をベースに作成し、`{{}}` プレースホルダを残さない。
- ユーザへのヒアリングは AskUserQuestion を使う。質問は 1 回あたり最大 4 問、選択肢には推奨案を先頭に置く。
- 各ステップの成果物はファイルに書いたうえで要点をユーザに提示し、承認を得てから次へ進む。
- コミットはユーザから指示があったときだけ行う。
- 知見の扱い: 実装中に「次回も使える発見」（ハマりどころ・ライブラリの癖・プロセス改善・ドメイン知識）があれば、その場で `.learn/` に記録する（[learn.md](learn.md)）。記録は安価に、昇格は `/sdd upgrade` で慎重に行う。
