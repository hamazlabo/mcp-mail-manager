/**
 * Secrets Manager `mail-mcp/<stage>/mail` からの接続設定読込（design.md 5 章, REQ-052）。
 * 必須は domain / user / password。ホストは省略時に MX レコード（優先度最小）から導出し、プロセス内でキャッシュする。
 * エラーメッセージにパスワード・ユーザ名を含めない。
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { promises as dns } from 'node:dns';
import type { MailConfig } from './types';

export type MxResolver = (domain: string) => Promise<{ exchange: string; priority: number }[]>;

export interface LoadMailConfigOptions {
  /** 既定: process.env.MAIL_SECRET_ARN */
  secretId?: string;
  client?: SecretsManagerClient;
  /** 既定: dns.promises.resolveMx */
  resolveMx?: MxResolver;
}

interface MailSecret {
  domain: string;
  user: string;
  password: string;
  imapHost?: string;
  smtpHost?: string;
  imapPort?: number;
  smtpPort?: number;
  smtpSecure?: boolean;
  fromName?: string;
  sentFolder?: string;
  trashFolder?: string;
}

const REQUIRED: (keyof MailSecret)[] = ['domain', 'user', 'password'];
const cache = new Map<string, Promise<MailConfig>>();
let defaultClient: SecretsManagerClient | undefined;

export function resetMailConfigCache(): void {
  cache.clear();
}

export async function loadMailConfig(options: LoadMailConfigOptions = {}): Promise<MailConfig> {
  const secretId = options.secretId ?? process.env.MAIL_SECRET_ARN;
  if (!secretId) throw new Error('MAIL_SECRET_ARN is not set');
  let pending = cache.get(secretId);
  if (!pending) {
    pending = load(secretId, options).catch((e) => {
      cache.delete(secretId);
      throw e;
    });
    cache.set(secretId, pending);
  }
  return pending;
}

async function load(secretId: string, options: LoadMailConfigOptions): Promise<MailConfig> {
  const client = options.client ?? (defaultClient ??= new SecretsManagerClient({}));
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const secret = parseSecret(res.SecretString ?? '');

  const resolveMx = options.resolveMx ?? ((d) => dns.resolveMx(d));
  const needMx = secret.imapHost === undefined || secret.smtpHost === undefined;
  const mxHost = needMx ? await lowestMx(secret.domain, resolveMx) : '';

  return {
    domain: secret.domain,
    user: secret.user,
    address: `${secret.user}@${secret.domain}`,
    password: secret.password,
    imapHost: secret.imapHost ?? mxHost,
    imapPort: secret.imapPort ?? 993,
    smtpHost: secret.smtpHost ?? mxHost,
    smtpPort: secret.smtpPort ?? 587,
    smtpSecure: secret.smtpSecure ?? false,
    ...(secret.fromName !== undefined ? { fromName: secret.fromName } : {}),
    sentFolder: secret.sentFolder ?? 'INBOX.Sent',
    trashFolder: secret.trashFolder ?? 'INBOX.Trash',
  };
}

function parseSecret(raw: string): MailSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('mail secret is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('mail secret must be a JSON object');
  const secret = parsed as Record<string, unknown>;
  const missing = REQUIRED.filter((k) => typeof secret[k] !== 'string' || secret[k] === '');
  if (missing.length > 0) throw new Error(`mail secret is missing required keys: ${missing.join(', ')}`);
  return secret as unknown as MailSecret;
}

async function lowestMx(domain: string, resolveMx: MxResolver): Promise<string> {
  let records: { exchange: string; priority: number }[];
  try {
    records = await resolveMx(domain);
  } catch (e) {
    throw new Error(`MX lookup failed for ${domain}: ${(e as Error).message}`);
  }
  if (records.length === 0) throw new Error(`MX lookup failed for ${domain}: no MX records`);
  return records.reduce((best, r) => (r.priority < best.priority ? r : best)).exchange;
}
