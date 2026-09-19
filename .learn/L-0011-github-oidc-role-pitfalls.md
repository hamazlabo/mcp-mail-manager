---
id: L-0011
date: 2026-09-19
task: T-004
category: pitfall
status: new
promoted_to:
promoted_in:
---

# GitHub OIDC デプロイロール: job が environment を持つと sub が変わる。IAM Role の Description は日本語不可

## 事象

- `deploy-dev.yml` / `deploy-prod.yml` の job は `environment: dev` / `production` を持つ。このとき OIDC トークンの `sub` は `repo:<owner>/<repo>:ref:refs/heads/<branch>` ではなく `repo:<owner>/<repo>:environment:<name>` になる。README の trust policy 例（ref のみ）では AssumeRoleWithWebIdentity が失敗する。
- CloudFormation で IAM Role の `Description` に日本語を書いたところ `Member must satisfy regular expression pattern: [\u0009\u000A\u000D -~¡-ÿ]*` で CREATE_FAILED になった。

## 知見

trust policy の `sub` は `StringLike` のリストで `ref:refs/heads/<branch>` と `environment:<name>` の両方を許可する（`infra/bootstrap/github-oidc.yaml`）。IAM の Description / Path 等は ASCII で書く。

## 適用先候補

- .github/workflows/README.md（反映済み）
- .spec/templates/design.md（CI/CD 節）
