import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailConfig } from '../../../src/core/types';

const config: MailConfig = {
  domain: 'example.net',
  user: 'someone',
  address: 'someone@example.net',
  password: 'hunter2-secret',
  imapHost: 'mail.example.net',
  imapPort: 993,
  smtpHost: 'mail.example.net',
  smtpPort: 587,
  smtpSecure: false,
  sentFolder: 'INBOX.Sent',
  trashFolder: 'INBOX.Trash',
};

const calls = vi.hoisted(() => [] as { method: string; args: unknown[] }[]);
const statusResult = vi.hoisted(() => ({ value: {} as unknown }));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor(...args: unknown[]) {
      calls.push({ method: 'new', args });
    }
    async connect() {
      calls.push({ method: 'connect', args: [] });
    }
    async status(...args: unknown[]) {
      calls.push({ method: 'status', args });
      return statusResult.value;
    }
    async mailboxOpen(...args: unknown[]) {
      calls.push({ method: 'mailboxOpen', args });
    }
    async logout() {
      calls.push({ method: 'logout', args: [] });
    }
  },
}));

import { mailboxStatus } from '../../../scripts/mailbox-status';

describe('mailboxStatus（REQ-005 の実機確認用、REQ-052）', () => {
  beforeEach(() => {
    calls.length = 0;
    statusResult.value = { path: 'INBOX', messages: 12, recent: 2, unseen: 3 };
  });

  it('messages / recent / unseen の 3 キーだけを返し、パスワードを含まない', async () => {
    const status = await mailboxStatus(config);

    expect(status).toStrictEqual({ messages: 12, recent: 2, unseen: 3 });
    expect(JSON.stringify(status)).not.toContain('hunter2');
  });

  it('フォルダを開かず（SELECT / EXAMINE なし）STATUS INBOX だけを発行して LOGOUT する', async () => {
    await mailboxStatus(config);

    expect(calls.map((c) => c.method)).toEqual(['new', 'connect', 'status', 'logout']);
    expect(calls[2].args).toEqual(['INBOX', { messages: true, recent: true, unseen: true }]);
    expect(calls[0].args[0]).toMatchObject({ host: 'mail.example.net', port: 993, secure: true, auth: { user: 'someone@example.net' } });
  });

  it('STATUS が失敗したら（imapflow は例外ではなく false を返す）0 件として出力せず例外にする', async () => {
    statusResult.value = false;

    await expect(mailboxStatus(config)).rejects.toThrow(/STATUS INBOX failed/);
    expect(calls.at(-1)?.method).toBe('logout');
  });
});
