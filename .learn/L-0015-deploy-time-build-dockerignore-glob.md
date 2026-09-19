---
id: L-0015
date: 2026-09-19
task: T-026
category: pitfall
status: new
promoted_to:
promoted_in:
---

# ContainerImageBuild は .dockerignore を GLOB として解釈し、`*` + `!path` の許可リストではドットファイルが漏れる

## 事象

`@cdklabs/deploy-time-build` の `ContainerImageBuild` は `.dockerignore` を読んで CDK Asset の `exclude` に渡すが、既定の `IgnoreMode.GLOB` では `*` がドットファイルに掛からない。`*` + `!dist/mcp/` + `!docker/` の許可リスト方式で synth したところ、アセットに `.env` / `.git` / `.claude` が入り、肝心の `dist/` と `docker/` が入っていなかった（S3 に認証情報が上がる寸前だった）。

## 知見

`ContainerImageBuild` には必ず `ignoreMode: IgnoreMode.DOCKER` を指定し、`cdk synth` 後に `cdk.out/asset.*/` の中身が意図したファイルだけ（ここでは `docker/Dockerfile` と `dist/mcp/main.js` の 2 つ）であることを確認する。ビルドコンテキストにリポジトリルートを使う場合は特に注意。

## 適用先候補

- .spec/design.md 3.1（反映: 配布の記述に ignoreMode を追記する）
- CLAUDE.md / .spec/templates/design.md（アセットの中身を確認する規律）
