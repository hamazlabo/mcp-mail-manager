---
id: L-0017
date: 2026-09-19
task: T-025, T-028
category: pitfall
status: new
promoted_to:
promoted_in:
---

# CloudFormation の動的参照 {{resolve:secretsmanager:...}} はカスタムリソースでは解決されない

## 事象

T-025 で正常性テスト用 Cognito ユーザのパスワードを `AwsCustomResource`（`AdminSetUserPassword`）に `secret.secretValueFromJson('password').unsafeUnwrap()`（= `{{resolve:secretsmanager:<arn>:SecretString:password::}}`）で渡した。デプロイは成功しユーザは CONFIRMED になったが、`InitiateAuth` は `NotAuthorizedException: Incorrect username or password` になった。CLI で Secrets Manager の値を `admin-set-user-password` し直すと通った。CloudFormation の公式ドキュメント「General considerations」に *Dynamic references can't be used for secure values (like those stored in Parameter Store or Secrets Manager) in custom resources.* と明記されている（テンプレート検証やデプロイでは弾かれず、文字列がそのまま渡る）。

## 知見

カスタムリソースへ秘密値を渡すには、`GetSecretValue` を別の `AwsCustomResource` で呼び `getResponseField('SecretString')` を `Fn::GetAtt` で渡す。CFN の組込関数では JSON を解析できないので、その秘密は JSON ではなく生の文字列で保存する。`logging: Logging.withDataHidden()` でハンドラのログに値を出さない。デプロイ後は必ず実際の認証（正常性テスト）で検証する。

## 適用先候補

- .spec/templates/design.md（Secrets とカスタムリソースの注意）
- CLAUDE.md
