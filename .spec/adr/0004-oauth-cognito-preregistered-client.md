# ADR-0004: MCP クライアント認証を OAuth 2.1 + Amazon Cognito（事前登録アプリクライアント、AgentCore JWT 認可）にする

- **日付**: 2026-09-19
- **ステータス**: Proposed
- **関連要件**: REQ-050, REQ-051, REQ-052, NFR-004
- **関連憲法条項**: 1. AWS 前提（認証・認可は AWS のマネージド機能: Cognito）

## 文脈 (Context)

MCP Authorization 仕様は OAuth 2.1（PKCE S256 必須、RFC 9728 Protected Resource Metadata、RFC 8414 AS Metadata、RFC 8707 resource indicator）を規定する。Claude 系クライアントは通常 Dynamic Client Registration (RFC 7591) または Client ID Metadata Document (CIMD) でクライアント登録するが、Amazon Cognito はどちらも未対応。
一方、Claude の公式ドキュメント（code.claude.com/docs/en/mcp, claude.com/docs/connectors/building/authentication）によれば:

- Claude Code は `claude mcp add --transport http --client-id <id> [--client-secret] --callback-port <port>` で事前登録クライアントを使える。コールバックは `http://localhost:<port>/callback`。
- Claude Desktop / claude.ai のカスタムコネクタは client ID（任意で secret）を入力でき、コールバックは `https://claude.ai/api/mcp/auth_callback`。
- クライアントは 401 の `WWW-Authenticate: Bearer resource_metadata="..."` から Protected Resource Metadata を辿り、そこに書かれた認可サーバの `/.well-known/oauth-authorization-server` または `/.well-known/openid-configuration` を読む。

AgentCore Runtime はインバウンド JWT 認可を内蔵し、Cognito の discovery URL と `allowedClients`（`client_id` クレーム）で検証する（ADR-0001）。Cognito のアクセストークンには `aud` が無いため `allowedAudience` は使わず、RFC 8707 の `resource` パラメータは Cognito が無視する（トークンの束縛は `client_id` で代替）。

ユーザは静的トークンではなく OAuth 2.1（Cognito）を選択した。

## 決定 (Decision)

Cognito User Pool（セルフサインアップ無効、ユーザは開発者 1 名 + 正常性テスト用 1 名）と Managed Login ドメイン、**公開アプリクライアント 1 つ**（シークレットなし、Authorization Code + PKCE、コールバック URL に `http://localhost:8765/callback` と `https://claude.ai/api/mcp/auth_callback` を登録、正常性テスト用に `USER_PASSWORD_AUTH` も許可）を CDK で作成する。DCR / CIMD の代替実装は作らない。

- トークン検証は AgentCore Runtime の JWT 認可（discovery URL = User Pool の `openid-configuration`、allowedClients = アプリクライアント ID）に委ねる。MCP サーバのコードは JWT を検証しない。
- façade（ADR-0001、CloudFront Functions）が `GET /.well-known/oauth-protected-resource`（`resource` = façade の `/mcp`、`authorization_servers` = façade のベース URL）と `GET /.well-known/oauth-authorization-server`（Cognito の `authorization_endpoint` / `token_endpoint` / `jwks_uri` / `issuer` を転記し、`code_challenge_methods_supported: ["S256"]` と `response_types_supported: ["code"]` を明示）を静的 JSON で提供する。
- 401 応答の `WWW-Authenticate` は façade の PRM URL を指す（viewer-request 関数がトークン無し / 期限切れを判定して返す。CloudFront はオリジンのエラー応答で viewer-response を呼ばないため上書き方式は使えない）。
- Claude Code は Cognito を直接辿ると PKCE 記載欠落で失敗する（anthropics/claude-code #13275、#35846。未修正）ため、façade のメタデータが必須である。

利用手順は README に記載する: Claude Code は `--client-id <CDK 出力 UserPoolClientId>` と `--callback-port 8765`、Claude Desktop はカスタムコネクタで client ID を入力する。

## 検討した選択肢

| 選択肢 | 利点 | 欠点 | コスト影響 |
|--------|------|------|------------|
| A: Cognito + 事前登録アプリクライアント + façade の well-known（採用） | AWS マネージド。ブラウザログイン・失効・MFA が使える。JWT 検証は AgentCore 内蔵。実装は well-known 2 本のみ | クライアント登録時に client ID とコールバックポートの手入力が要る | Cognito 無料枠（10,000 MAU）内で 0 USD |
| B: A + DCR シム（`/register` が固定 client ID を返す） | クライアントが自動登録できる | Claude Code のコールバックポートが可変のため結局 `--callback-port` が必要。攻撃面が増える | 0 USD |
| C: 静的 Bearer トークン | 最も単純 | ユーザが不採用。AgentCore の JWT 認可と噛み合わず自前検証が要る | 0 USD |
| D: 自前 OAuth サーバ（Lambda、kane.mx 方式の authorize/token プロキシ） | DCR・可変ポートまで完全対応 | 認可プロキシの自作はセキュリティリスクと実装量が大きい（約 500 行）。憲法（マネージド優先）に反する | 0 USD だが工数大 |

## 結果 (Consequences)

- 良い点: 認証情報は Cognito と Secrets Manager に閉じ、MCP サーバは認証コードを持たない。
- 悪い点 / トレードオフ: Claude クライアントの仕様変更で登録手順が変わりうる。Claude Code の OAuth フローが façade + Cognito と実際に噛み合うかは認証 E2E タスクで最初に検証し、噛み合わなければ B へ切り替える（本 ADR を Superseded にする）。
- 憲法との関係: 準拠。
