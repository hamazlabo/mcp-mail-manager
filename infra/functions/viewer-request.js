// CloudFront Function (viewer-request, cloudfront-js-2.0)。
// OAuth の well-known 2 本を静的 JSON で返し、POST /mcp を AgentCore の呼出 URL へ書き換える（design.md 3.1b）。
// __RUNTIME_ARN__ / __COGNITO_ISSUER__ / __COGNITO_DOMAIN__ / __JWKS_URI__ は CDK が synth 時に置換する。
var RUNTIME_ARN = '__RUNTIME_ARN__';
var COGNITO_ISSUER = '__COGNITO_ISSUER__';
var COGNITO_DOMAIN = '__COGNITO_DOMAIN__';
var JWKS_URI = '__JWKS_URI__';

function json(status, description, body) {
  return {
    statusCode: status,
    statusDescription: description,
    headers: {
      'content-type': { value: 'application/json' },
      'cache-control': { value: 'no-store' }
    },
    body: JSON.stringify(body)
  };
}

function handler(event) {
  var request = event.request;
  var method = request.method;
  var uri = request.uri;
  // façade 自身の URL は Host ヘッダから組み立てる（配布ドメインは作成前に分からない）
  var self = 'https://' + request.headers.host.value;

  if (method === 'GET' && uri === '/.well-known/oauth-protected-resource') {
    return json(200, 'OK', {
      resource: self + '/mcp',
      authorization_servers: [self],
      bearer_methods_supported: ['header']
    });
  }
  if (method === 'GET' && uri === '/.well-known/oauth-authorization-server') {
    // Cognito は RFC 8414 メタデータと PKCE の広告を持たないため、ここで補う（ADR-0004）
    return json(200, 'OK', {
      issuer: COGNITO_ISSUER,
      authorization_endpoint: COGNITO_DOMAIN + '/oauth2/authorize',
      token_endpoint: COGNITO_DOMAIN + '/oauth2/token',
      revocation_endpoint: COGNITO_DOMAIN + '/oauth2/revoke',
      jwks_uri: JWKS_URI,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['openid', 'email', 'profile']
    });
  }
  if (method === 'POST' && uri === '/mcp') {
    request.uri = '/runtimes/' + encodeURIComponent(RUNTIME_ARN) + '/invocations';
    request.querystring.qualifier = { value: 'DEFAULT' };
    return request;
  }
  return json(404, 'Not Found', { error: 'not found' });
}
