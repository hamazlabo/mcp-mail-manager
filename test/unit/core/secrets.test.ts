import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMailConfig, resetMailConfigCache } from '../../../src/core/secrets';

const sm = mockClient(SecretsManagerClient);
const SECRET_ID = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:mail-mcp/dev/mail-abc';
const PASSWORD = 'Sup3r-Secret-Pw';

function secret(json: unknown) {
  sm.on(GetSecretValueCommand, { SecretId: SECRET_ID }).resolves({ SecretString: JSON.stringify(json) });
}

describe('loadMailConfig', () => {
  beforeEach(() => {
    sm.reset();
    resetMailConfigCache();
  });

  it('fails when a required key is missing, without leaking the password', async () => {
    secret({ domain: 'example.net', password: PASSWORD });
    const err = await loadMailConfig({ secretId: SECRET_ID }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/user/);
    expect((err as Error).message).not.toContain(PASSWORD);
  });

  it('derives hosts from the lowest-priority MX and builds the login address', async () => {
    secret({ domain: 'example.net', user: 'someone', password: PASSWORD });
    const resolveMx = vi.fn().mockResolvedValue([
      { exchange: 'backup.mx.example', priority: 20 },
      { exchange: 'www123.sakura.ne.jp', priority: 10 },
    ]);
    const cfg = await loadMailConfig({ secretId: SECRET_ID, resolveMx });
    expect(resolveMx).toHaveBeenCalledWith('example.net');
    expect(cfg).toEqual({
      domain: 'example.net',
      user: 'someone',
      address: 'someone@example.net',
      password: PASSWORD,
      imapHost: 'www123.sakura.ne.jp',
      imapPort: 993,
      smtpHost: 'www123.sakura.ne.jp',
      smtpPort: 587,
      smtpSecure: false,
      sentFolder: 'INBOX.Sent',
      trashFolder: 'INBOX.Trash',
    });
  });

  it('does not resolve MX when imapHost and smtpHost are given', async () => {
    secret({
      domain: 'example.net',
      user: 'someone',
      password: PASSWORD,
      imapHost: 'imap.example.net',
      smtpHost: 'smtp.example.net',
      smtpPort: 465,
      smtpSecure: true,
      fromName: 'Someone',
      sentFolder: 'Sent',
      trashFolder: 'Trash',
    });
    const resolveMx = vi.fn();
    const cfg = await loadMailConfig({ secretId: SECRET_ID, resolveMx });
    expect(resolveMx).not.toHaveBeenCalled();
    expect(cfg).toMatchObject({
      imapHost: 'imap.example.net',
      smtpHost: 'smtp.example.net',
      smtpPort: 465,
      smtpSecure: true,
      fromName: 'Someone',
      sentFolder: 'Sent',
      trashFolder: 'Trash',
    });
  });

  it('reports MX failures with the domain only (no password, no user)', async () => {
    secret({ domain: 'example.net', user: 'someone', password: PASSWORD });
    const resolveMx = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const err = await loadMailConfig({ secretId: SECRET_ID, resolveMx }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/MX lookup failed for example\.net/);
    expect((err as Error).message).not.toContain(PASSWORD);
    expect((err as Error).message).not.toContain('someone');
  });

  it('caches the config so the secret and MX are read once', async () => {
    secret({ domain: 'example.net', user: 'someone', password: PASSWORD });
    const resolveMx = vi.fn().mockResolvedValue([{ exchange: 'mx.example.net', priority: 10 }]);
    const first = await loadMailConfig({ secretId: SECRET_ID, resolveMx });
    const second = await loadMailConfig({ secretId: SECRET_ID, resolveMx });
    expect(second).toBe(first);
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    expect(resolveMx).toHaveBeenCalledTimes(1);
  });

  it('uses MAIL_SECRET_ARN when secretId is not given', async () => {
    vi.stubEnv('MAIL_SECRET_ARN', SECRET_ID);
    secret({ domain: 'example.net', user: 'someone', password: PASSWORD, imapHost: 'h', smtpHost: 'h' });
    const cfg = await loadMailConfig();
    expect(cfg.address).toBe('someone@example.net');
    vi.unstubAllEnvs();
  });
});
