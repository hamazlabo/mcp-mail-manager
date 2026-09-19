import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeImapSession } from '../../../src/core/imap-fake';
import { NodemailerSender, type SmtpTransport } from '../../../src/core/smtp';
import type { MailConfig, ScheduledItem, ScheduledStatus } from '../../../src/core/types';
import { createHandler } from '../../../src/scheduled-send/handler';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const config: MailConfig = {
  domain: 'example.net',
  user: 'me',
  address: 'me@example.net',
  password: 'S3cret-Pass',
  imapHost: 'mail.example.net',
  imapPort: 993,
  smtpHost: 'mail.example.net',
  smtpPort: 587,
  smtpSecure: false,
  sentFolder: 'INBOX.Sent',
  trashFolder: 'INBOX.Trash',
};

const base: ScheduledItem = {
  scheduleId: 'sch-1',
  status: 'pending',
  sendAt: '2026-10-01T09:00:00.000Z',
  to: ['bob@example.net'],
  cc: [],
  bcc: [],
  subject: 'later',
  body: 'hi',
  messageId: '<uuid-1@example.net>',
  scheduleName: 'mail-mcp-sch-1',
  attempts: 0,
  createdAt: '2026-09-19T00:00:00.000Z',
};

/** DynamoDB の Scheduled アイテム 1 件を模した状態機械。条件付き更新の成否を本物と同じ規則で判定する */
function simulateTable(initial: Partial<ScheduledItem>) {
  const row: ScheduledItem = { ...base, ...initial };
  ddbMock.on(GetCommand).callsFake(async () => ({ Item: { ...row, PK: 'SCHED#sch-1', SK: 'META' } }));
  ddbMock.on(UpdateCommand).callsFake(async (input: { ConditionExpression?: string; ExpressionAttributeValues?: Record<string, unknown> }) => {
    const v = input.ExpressionAttributeValues ?? {};
    if (input.ConditionExpression === '#status = :pending') {
      if (row.status !== 'pending') throw new ConditionalCheckFailedException({ $metadata: {}, message: 'The conditional request failed' });
      row.status = 'sending';
      row.attempts += 1;
      row.updatedAt = v[':now'] as string;
      return { Attributes: { ...row, PK: 'SCHED#sch-1', SK: 'META' } };
    }
    if (input.ConditionExpression === '#status = :sending') {
      if (row.status !== 'sending') throw new ConditionalCheckFailedException({ $metadata: {}, message: 'The conditional request failed' });
      row.status = v[':pending'] as ScheduledStatus;
      return {};
    }
    row.status = v[':status'] as ScheduledStatus;
    if (typeof v[':error'] === 'string') row.error = v[':error'];
    if (typeof v[':ttl'] === 'number') row.ttl = v[':ttl'];
    return {};
  });
  return row;
}

let imap: FakeImapSession;
let sent: Record<string, unknown>[];
let logSpy: ReturnType<typeof spyLog>;

function spyLog() {
  return vi.spyOn(console, 'log').mockImplementation(() => undefined);
}

function metricsEmitted(): number {
  return logSpy.mock.calls.filter((c) => String(c[0]).includes('"ScheduledSendFailed":1')).length;
}

function handlerWith(transport: SmtpTransport, imapFactory = async () => imap) {
  return createHandler({
    ddb,
    tableName: 'MailTable-test',
    loadConfig: async () => config,
    openImap: imapFactory,
    createSmtp: (c) => new NodemailerSender(c, transport),
    now: () => new Date('2026-10-01T09:00:10Z'),
    stage: 'test',
  });
}

const okTransport: SmtpTransport = {
  async sendMail(opts) {
    sent.push(opts as Record<string, unknown>);
    return { messageId: opts.messageId } as never;
  },
};

beforeEach(() => {
  ddbMock.reset();
  imap = new FakeImapSession({ config });
  sent = [];
  logSpy = spyLog();
});
afterEach(() => logSpy.mockRestore());

describe('scheduled-send handler (REQ-042 / REQ-043)', () => {
  it('sends exactly once when the same schedule fires twice concurrently, then marks sent', async () => {
    const row = simulateTable({});
    const handler = handlerWith(okTransport);

    await Promise.all([handler({ scheduleId: 'sch-1' }), handler({ scheduleId: 'sch-1' })]);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ messageId: '<uuid-1@example.net>', to: ['bob@example.net'], from: 'me@example.net' });
    expect(await imap.searchSent('<uuid-1@example.net>')).toBe(true);
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(1);
    expect(row.ttl).toBeGreaterThan(0);
    expect(metricsEmitted()).toBe(0);
  });

  it('re-fired while a stale "sending": does not resend; failed(unknown-delivery) + metric when Sent lacks the message', async () => {
    const row = simulateTable({ status: 'sending', attempts: 1, updatedAt: '2026-10-01T08:50:00Z' });

    await handlerWith(okTransport)({ scheduleId: 'sch-1' });

    expect(sent).toHaveLength(0);
    expect(imap.calls).toContain('searchSent(<uuid-1@example.net>)');
    expect(row.status).toBe('failed');
    expect(row.error).toBe('unknown-delivery');
    expect(metricsEmitted()).toBe(1);
  });

  it('re-fired while a stale "sending": marks sent without resending when Sent already has the message', async () => {
    const row = simulateTable({ status: 'sending', attempts: 1, updatedAt: '2026-10-01T08:50:00Z' });
    imap.addMessage('INBOX.Sent', Buffer.from('Message-ID: <uuid-1@example.net>\r\nSubject: later\r\n\r\nhi\r\n'));

    await handlerWith(okTransport)({ scheduleId: 'sch-1' });

    expect(sent).toHaveLength(0);
    expect(row.status).toBe('sent');
    expect(metricsEmitted()).toBe(0);
  });

  it('leaves a recent "sending" alone (another invocation is still sending): no IMAP, no state change, no metric', async () => {
    const row = simulateTable({ status: 'sending', attempts: 1, updatedAt: '2026-10-01T09:00:05Z' });
    const openImap = vi.fn(async () => imap);

    await handlerWith(okTransport, openImap)({ scheduleId: 'sch-1' });

    expect(openImap).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: 'sending', attempts: 1 });
    expect(metricsEmitted()).toBe(0);
  });

  it('does nothing for a cancelled schedule (no SMTP, no IMAP, no state change)', async () => {
    const row = simulateTable({ status: 'cancelled' });
    const openImap = vi.fn(async () => imap);

    await handlerWith(okTransport, openImap)({ scheduleId: 'sch-1' });

    expect(sent).toHaveLength(0);
    expect(openImap).not.toHaveBeenCalled();
    expect(row.status).toBe('cancelled');
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1); // 失敗した claim だけ
  });

  it('SMTP failure: releases to pending and rethrows twice, then fails with the reason and a metric on the 3rd attempt', async () => {
    const row = simulateTable({});
    const failing: SmtpTransport = {
      async sendMail() {
        throw new Error(`535 auth failed for ${config.password}`);
      },
    };
    const handler = handlerWith(failing);

    await expect(handler({ scheduleId: 'sch-1' })).rejects.toThrow(/SMTP send failed/);
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    await expect(handler({ scheduleId: 'sch-1' })).rejects.toThrow(/SMTP send failed/);
    expect(row).toMatchObject({ status: 'pending', attempts: 2 });
    await expect(handler({ scheduleId: 'sch-1' })).resolves.toBeUndefined();

    expect(row).toMatchObject({ status: 'failed', attempts: 3 });
    expect(row.error).toMatch(/SMTP send failed/);
    expect(row.error).not.toContain(config.password);
    expect(metricsEmitted()).toBe(1);
    expect(imap.calls.some((c) => c.startsWith('append('))).toBe(false);
    expect(imap.calls.filter((c) => c === 'close()')).toHaveLength(3);
  });

  it('APPEND failure after a successful SMTP send: marks sent with an error, never resends', async () => {
    const row = simulateTable({});
    imap = new FakeImapSession({ config, folders: ['INBOX'] }); // Sent フォルダ無し → APPEND が失敗

    await expect(handlerWith(okTransport)({ scheduleId: 'sch-1' })).resolves.toBeUndefined();

    expect(sent).toHaveLength(1);
    expect(row.status).toBe('sent');
    expect(row.error).toBe('sent-but-append-failed');
    expect(metricsEmitted()).toBe(0);
  });
});
