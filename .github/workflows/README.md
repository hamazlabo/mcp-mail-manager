# CI/CD セットアップ

## パイプライン

```
PR → ci.yml            ユニットテスト + cdk synth（AWS 不要）
push develop → deploy-dev.yml
    deploy:  npm test → OIDC で dev ロール → cdk deploy (stage=dev) → 正常性テスト
    promote: テスト済み SHA を main へ fast-forward → deploy-prod.yml を起動
main → deploy-prod.yml OIDC で prod ロール → cdk deploy (stage=prod) → 正常性テスト
```

main には正常性テストを通過した commit だけが入る。人間は main に直接 push しない。

## プロジェクト側の契約

ワークフローは次の npm スクリプトと CDK の慣習に依存する。

| 契約 | 内容 |
|------|------|
| `npm test` | ユニットテスト。AWS 不要 |
| `npm run test:smoke` | 正常性テスト。`CDK_OUTPUTS_FILE`（`cdk deploy --outputs-file` の JSON）と `STAGE` を読んでデプロイ済み環境を叩く |
| `npx cdk deploy --all --context stage=<dev|prod>` | `stage` コンテキストでスタック名・パラメータを切り替える |
| Node.js 22 | `node-version` を変える場合は 3 ファイルとも修正する |

## GitHub 側の設定

### Repository variables (Settings → Secrets and variables → Actions → Variables)

| 変数 | 値 |
|------|----|
| `AWS_REGION` | 省略時 `ap-northeast-1` |
| `AWS_DEV_ROLE_ARN` | dev アカウントの OIDC ロール ARN。未設定の間は deploy-dev をスキップ |
| `AWS_PROD_ROLE_ARN` | prod アカウントの OIDC ロール ARN。未設定の間は deploy-prod をスキップ |

### Environments (Settings → Environments)

- `dev`: 保護なし。
- `production`: Required reviewers を設定すると本番デプロイ前に承認を挟める（public リポジトリまたは Pro/Team 以上）。

### Rulesets (Settings → Rules → Rulesets)

main に対して次を推奨する。

- Block force pushes、Restrict deletions。
- 「Require a pull request」は**設定しない**。promote ジョブの fast-forward push を止めてしまう。
  人間の直接 push も禁止したい場合は、GitHub App のトークンで push するよう promote ジョブを変え、その App を bypass list に入れる。

## AWS 側の設定（dev / prod 各アカウント）

1. IAM → Identity providers に GitHub の OIDC プロバイダを追加する。
   - Provider URL: `https://token.actions.githubusercontent.com`
   - Audience: `sts.amazonaws.com`
2. デプロイ用ロールを作成し、trust policy でリポジトリとブランチを制限する。

   dev（develop ブランチのみ）:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
         "StringLike": { "token.actions.githubusercontent.com:sub": "repo:<OWNER>/<REPO>:ref:refs/heads/develop" }
       }
     }]
   }
   ```

   prod は `sub` を `repo:<OWNER>/<REPO>:ref:refs/heads/main` にする。
   Environment を使う場合は `repo:<OWNER>/<REPO>:environment:production` も許可する。

3. ロールの権限: CDK のデプロイロール（`cdk-hnb659fds-deploy-role-*`, `cdk-hnb659fds-file-publishing-role-*` など）への `sts:AssumeRole` を許可する。
4. 各アカウントで `npx cdk bootstrap` を一度実行する。

## 落とし穴

- `GITHUB_TOKEN` による push は `push` イベントのワークフローを起動しない。deploy-prod は `gh workflow run` で明示的に起動している。
- 正常性テスト失敗時、main は更新されないが dev スタックは壊れた状態で残る。次の push で直すか、main の SHA で再デプロイする。
- private リポジトリ（Free プラン）では Actions が 2,000 分/月、Rulesets と Environment protection rules は使えない。
