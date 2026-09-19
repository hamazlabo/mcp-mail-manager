---
id: L-0018
date: 2026-09-19
task: T-027, T-028
category: pitfall
status: new
promoted_to:
promoted_in:
---

# CloudFront はオリジンのエラー応答（4xx/5xx）で viewer-response 関数を呼ばない

## 事象

AgentCore の 401 応答の `WWW-Authenticate` を façade の PRM に向け直す viewer-response 関数を関連付けたが、実機ではヘッダが AgentCore のままだった。応答には `x-cache: Error from cloudfront` が付いており、CloudFront がオリジンの 401 を「エラー応答」として処理していた。`aws cloudfront test-function` では関数は正しく書き換える（関数の問題ではない）。CloudFront Functions のログ（us-east-1）にもエラーは無い。

## 知見

オリジンが返す 4xx/5xx のヘッダを CloudFront Function（viewer-response）で書き換えることはできない。認証エラーの応答を制御したいなら viewer-request 側で先に判定する（トークン無し・JWT の `exp` 期限切れ・形式不正は viewer-request が 401 を返す。ランタイム 2.0 は `atob()` と `Date` が使える。署名検証はオリジンに任せる）。実機の応答ヘッダに `x-cache: Error from cloudfront` が出たら viewer-response は動いていない。

## 適用先候補

- .spec/templates/design.md（CloudFront Functions の制約）
- CLAUDE.md
