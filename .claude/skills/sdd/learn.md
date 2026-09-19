# /sdd learn <知見>

実装中に得た知見を `.learn/` に 1 件 1 ファイルで記録する。
`/sdd develop` の完了処理からも同じ手順で呼ばれる。

## 手順

1. `.learn/` の既存ファイルから `L-NNNN` の最大番号を求め、+1 を新しい ID とする（存在しなければ `L-0001`）。
2. 同じ内容の知見が既にあれば新規作成せず、既存ファイルの「事象」に事例を追記して `date` を更新する。
3. `.spec/templates/learn.md` を雛形に `.learn/L-NNNN-<slug>.md` を作成する。`<slug>` は英小文字とハイフンの短い要約。
4. 引数だけで埋まらない項目（事象・適用先候補）は、直近の作業内容から補う。推測できない場合はユーザに 1 問だけ聞く。
5. 作成したファイルパスと 1 行要約を報告する。

## 記録する価値がある知見

- 再現する失敗とその原因（ライブラリの癖、AWS サービスの制限、モックの落とし穴）
- spec（design.md / task.md）や手順書（init.md / develop.md）の不足・不正確
- 判断の根拠になった計測値（レイテンシ、コスト、上限値）
- ドメイン固有の前提や外部仕様

## 記録しないもの

- 一度きりのタイプミスや環境固有の一時的な不調
- すでに CLAUDE.md・憲法・design.md に書かれていること
- タスク固有の TODO（task.md に書く）

## category の選び方

| category | 昇格先の典型 |
|----------|--------------|
| `process` | `.claude/skills/sdd/*.md`, `CLAUDE.md` |
| `tech` | `.spec/design.md`, `.spec/templates/design.md` |
| `domain` | `.spec/specify.md` の用語集, `.spec/requirements.md` |
| `pitfall` | `CLAUDE.md`, 該当コードのコメント |
| `constitution` | 人間へ提案のみ（憲法は編集しない） |
