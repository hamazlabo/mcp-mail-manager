import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// CDK が synth 時に置換するプレースホルダのサンプル値
const SAMPLE: Record<string, string> = {
  __RUNTIME_ARN__: 'arn:aws:bedrock-agentcore:ap-northeast-1:123456789012:runtime/mail_mcp_dev-abc123',
  __COGNITO_ISSUER__: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_XXXX',
  __COGNITO_DOMAIN__: 'https://mail-mcp-dev-123456789012.auth.ap-northeast-1.amazoncognito.com',
  __JWKS_URI__: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_XXXX/.well-known/jwks.json',
};
const HOST = 'd123.cloudfront.net';

type CfHeaders = Record<string, { value: string }>;
interface CfRequest { method: string; uri: string; querystring: Record<string, { value: string }>; headers: CfHeaders; cookies: Record<string, unknown> }
interface CfResponse { statusCode: number; statusDescription?: string; headers: CfHeaders; body?: string }

function load(name: string): (event: Record<string, unknown>) => CfRequest | CfResponse {
  const file = resolve('infra/functions', name);
  let code = readFileSync(file, 'utf8');
  for (const [k, v] of Object.entries(SAMPLE)) code = code.split(k).join(v);
  // CloudFront Functions の `function handler(event)` をそのまま評価して取り出す
  return new Function(`${code}\nreturn handler;`)();
}
/** 署名検証はしないので payload だけ本物っぽい JWT を作る（base64url） */
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (exp: number) => `${b64url({ alg: 'RS256', kid: 'k' })}.${b64url({ sub: 'u', client_id: 'c', exp })}.sig`;
const NOW = Math.floor(Date.now() / 1000);
const VALID_TOKEN = jwt(NOW + 3600);
const request = (method: string, uri: string, authorization?: string | null): CfRequest => ({
  method,
  uri,
  querystring: {},
  headers: {
    host: { value: HOST },
    ...(authorization === null ? {} : { authorization: { value: authorization ?? `Bearer ${VALID_TOKEN}` } }),
  },
  cookies: {},
});
const PRM_CHALLENGE = `resource_metadata="https://${HOST}/.well-known/oauth-protected-resource"`;
const body = (r: CfRequest | CfResponse) => JSON.parse((r as CfResponse).body ?? '');

describe('viewer-request function', () => {
  const handler = load('viewer-request.js');

  it('serves protected resource metadata pointing at this façade', () => {
    const res = handler({ request: request('GET', '/.well-known/oauth-protected-resource') }) as CfResponse;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type'].value).toBe('application/json');
    expect(body(res)).toEqual({
      resource: `https://${HOST}/mcp`,
      authorization_servers: [`https://${HOST}`],
      bearer_methods_supported: ['header'],
    });
  });

  it('serves authorization server metadata with Cognito endpoints and S256', () => {
    const res = handler({ request: request('GET', '/.well-known/oauth-authorization-server') }) as CfResponse;
    expect(res.statusCode).toBe(200);
    const meta = body(res);
    expect(meta.issuer).toBe(SAMPLE.__COGNITO_ISSUER__);
    expect(meta.authorization_endpoint).toBe(`${SAMPLE.__COGNITO_DOMAIN__}/oauth2/authorize`);
    expect(meta.token_endpoint).toBe(`${SAMPLE.__COGNITO_DOMAIN__}/oauth2/token`);
    expect(meta.revocation_endpoint).toBe(`${SAMPLE.__COGNITO_DOMAIN__}/oauth2/revoke`);
    expect(meta.jwks_uri).toBe(SAMPLE.__JWKS_URI__);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.response_types_supported).toEqual(['code']);
    expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(meta.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(meta.scopes_supported).toEqual(['openid', 'email', 'profile']);
  });

  it('rewrites POST /mcp to the AgentCore invocation URL and keeps the Authorization header', () => {
    const req = handler({ request: request('POST', '/mcp') }) as CfRequest;
    expect(req.uri).toBe(`/runtimes/${encodeURIComponent(SAMPLE.__RUNTIME_ARN__)}/invocations`);
    expect(req.querystring.qualifier).toEqual({ value: 'DEFAULT' });
    expect(req.headers.authorization.value).toBe(`Bearer ${VALID_TOKEN}`);
    expect((req as unknown as CfResponse).statusCode).toBeUndefined();
  });

  it('returns 404 for anything else', () => {
    expect((handler({ request: request('GET', '/mcp') }) as CfResponse).statusCode).toBe(404);
    expect((handler({ request: request('GET', '/') }) as CfResponse).statusCode).toBe(404);
    expect((handler({ request: request('POST', '/other') }) as CfResponse).statusCode).toBe(404);
  });
});

describe('viewer-request function: authentication pre-check (CloudFront skips viewer-response on origin errors)', () => {
  const handler = load('viewer-request.js');

  it('answers 401 with the façade protected resource metadata when Authorization is missing', () => {
    const res = handler({ request: request('POST', '/mcp', null) }) as CfResponse;
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate'].value).toBe(`Bearer ${PRM_CHALLENGE}`);
    expect(res.headers['content-type'].value).toBe('application/json');
  });

  it('answers 401 (invalid_token) when the bearer token is expired or malformed, without forwarding', () => {
    for (const auth of [`Bearer ${jwt(NOW - 60)}`, 'Bearer not-a-jwt', 'Basic abc']) {
      const res = handler({ request: request('POST', '/mcp', auth) }) as CfResponse;
      expect(res.statusCode, auth).toBe(401);
      expect(res.headers['www-authenticate'].value).toContain('error="invalid_token"');
      expect(res.headers['www-authenticate'].value).toContain(PRM_CHALLENGE);
    }
  });

  it('forwards a bearer token that has not expired (signature is verified by AgentCore)', () => {
    const req = handler({ request: request('POST', '/mcp') }) as CfRequest;
    expect((req as unknown as CfResponse).statusCode).toBeUndefined();
    expect(req.uri).toContain('/invocations');
  });
});

it('keeps the function within the 10 KB CloudFront Functions limit', () => {
  expect(statSync(resolve('infra/functions', 'viewer-request.js')).size).toBeLessThan(10 * 1024);
});
