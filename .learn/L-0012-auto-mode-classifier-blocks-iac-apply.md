---
id: L-0012
date: 2026-09-19
task: T-004
category: process
status: new
promoted_to:
promoted_in:
---

# Claude Code の auto mode 分類器は IaC の適用コマンドを止める。settings.json の allow ルールで通す

## 事象

`/sdd develop` の実行中、`aws cloudformation deploy` と prod への `cdk bootstrap` が auto mode の分類器に `[Protected-Scope IaC Apply]` として拒否された（dev の `cdk bootstrap` は通った。判定は一貫しない）。ユーザの承認を得て `.claude/settings.json` の `permissions.allow` に `Bash(aws cloudformation deploy:*)` / `Bash(npx cdk bootstrap:*)` / `Bash(npx cdk deploy:*)` / `Bash(aws secretsmanager put-secret-value:*)` / `Bash(aws cognito-idp admin-create-user:*)` / `Bash(gh variable set:*)` / `Bash(git push:*)` を追加したところ通るようになった。allow ルールはコマンドの先頭一致なので、`cd ... &&` を前置すると効かない。

## 知見

デプロイを伴う `/sdd develop` の開始時に、必要な適用コマンドの allow ルールが settings.json にあるかを確認し、無ければ最初の質問でまとめてユーザに許可を求める。allow ルール対象のコマンドは `cd` を前置せず絶対パスで書く。

## 適用先候補

- .claude/skills/sdd/develop.md（前提の確認項目に追加）
- CLAUDE.md
