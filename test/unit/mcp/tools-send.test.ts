import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeImapSession } from '../../../src/core/imap-fake';
import { NodemailerSender, type SmtpTransport } from '../../../src/core/smtp';
import type { MailStore } from '../../../src/core/store';
import type { MailConfig, MessageItem } from '../../../src/core/types';
import type { ToolContext } from '../../../src/mcp/context';
import { createMcpServer } from '../../../src/mcp/server';
import { registerForwardMessage } from '../../../src/mcp/tools/forward_message';
import { registerReplyMessage } from '../../../src/mcp/tools/reply_message';
import { registerSendMessage } from '../../../src/mcp/tools/send_message';

const config: MailConfig = {
  domain: 'example.net',
  user: 'me',
  address: 'me@example.net',
  password: 'S3cret',
  imapHost: 'mail.example.net',
  imapPort: 993,
  smtpHost: 'mail.example.net',
  smtpPort: 587,
  smtpSecure: false,
  sentFolder: 'INBOX.Sent',
  trashFolder: 'INBOX.Trash',
};

const originalRaw = Buffer.from(
  [
    'From: Alice <alice@example.org>',
    'To: me@example.net',
    'Cc: carol@example.org',
    'Subject: Lunch?',
    'Date: Mon, 01 Sep 2026 10:00:00 +0900',
    'Message-ID: <orig-1@example.org>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Are you free on Friday?',
    '',
  ].join('\r\n'),
);

const original: MessageItem = {
  id: 'msg-1',
  messageId: '<orig-1@example.org>',
  folder: 'INBOX',
  uid: 7,
  uidValidity: 1,
  subject: 'Lunch?',
  from: 'Alice <alice@example.org>',
  to: ['me@example.net'],
  cc: ['carol@example.org'],
  receivedAt: '2026-09-01T01:00:00.000Z',
  seen: true,
  flagged: false,
  hasAttachments: false,
  attachments: [],
  size: originalRaw.length,
  s3Key: 'raw/msg-1.eml',
  subjectLower: 'lunch?',
  fromLower: 'alice <alice@example.org>',
  toLower: 'me@example.net',
};

let imap: FakeImapSession;
let sent: Record<string, unknown>[];
let client: Client;

async function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

beforeEach(async () => {
  imap = new FakeImapSession({ config });
  sent = [];
  const transport = {
    async sendMail(opts: Record<string, unknown>) {
      sent.push(opts);
      return { messageId: opts.messageId };
    },
  } as unknown as SmtpTransport;
  const store = {
    getMessage: async (id: string) => (id === 'msg-1' ? original : undefined),
    getRaw: async (id: string) => (id === 'msg-1' ? originalRaw : undefined),
  } as unknown as MailStore;
  const ctx: ToolContext = {
    store,
    loadConfig: async () => config,
    openImap: async () => imap,
    createSmtp: (c) => new NodemailerSender(c, transport),
    scheduler: { create: async () => undefined, remove: async () => undefined },
    now: () => new Date('2026-09-19T12:00:00Z'),
  };

  const server = createMcpServer((s) => {
    registerSendMessage(s, ctx);
    registerReplyMessage(s, ctx);
    registerForwardMessage(s, ctx);
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
});

describe('send tools (REQ-020〜022)', () => {
  it('lists the three send tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['forward_message', 'reply_message', 'send_message']);
  });

  it('rejects an invalid recipient without sending or appending', async () => {
    const result = await callTool('send_message', { to: ['not-an-address'], subject: 's', body: 'b' });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('invalid recipient') });
    expect(sent).toHaveLength(0);
    expect(imap.calls.some((c) => c.startsWith('append('))).toBe(false);
  });

  it('fails reply / forward when the original message does not exist', async () => {
    const reply = await callTool('reply_message', { id: 'nope', body: 'x' });
    const forward = await callTool('forward_message', { id: 'nope', to: ['bob@example.net'] });

    for (const r of [reply, forward]) {
      expect(r.isError).toBe(true);
      expect(r.content[0]).toMatchObject({ text: expect.stringContaining('message not found: nope') });
    }
    expect(sent).toHaveLength(0);
  });

  it('send_message returns the messageId and the message is APPENDed to Sent', async () => {
    const result = await callTool('send_message', { to: ['bob@example.net'], cc: ['carol@example.net'], subject: 'hello', body: 'hi' });

    expect(result.isError).toBeUndefined();
    const { messageId } = JSON.parse((result.content[0] as { text: string }).text) as { messageId: string };
    expect(messageId).toMatch(/^<[0-9a-f-]+@example\.net>$/);
    expect(sent[0]).toMatchObject({ messageId, to: ['bob@example.net'], cc: ['carol@example.net'], from: 'me@example.net', text: 'hi' });
    expect(imap.calls.at(-1)).toBe('close()'); // withImap がセッションを閉じる
    expect(await imap.searchSent(messageId)).toBe(true);
  });

  it('reply_message threads on the original and replies to its sender (replyAll adds Cc without self)', async () => {
    const result = await callTool('reply_message', { id: 'msg-1', body: 'Yes!', replyAll: true });

    expect(result.isError).toBeUndefined();
    expect(sent[0]).toMatchObject({
      to: ['Alice <alice@example.org>'],
      cc: ['carol@example.org'],
      subject: 'Re: Lunch?',
      inReplyTo: '<orig-1@example.org>',
      references: ['<orig-1@example.org>'],
      text: 'Yes!',
    });
  });

  it('forward_message prefixes Fwd: and quotes the original after the comment', async () => {
    const result = await callTool('forward_message', { id: 'msg-1', to: ['bob@example.net'], comment: 'FYI' });

    expect(result.isError).toBeUndefined();
    const mail = sent[0] as { subject: string; text: string; to: string[] };
    expect(mail.subject).toBe('Fwd: Lunch?');
    expect(mail.to).toEqual(['bob@example.net']);
    expect(mail.text).toMatch(/^FYI\n\n---------- Forwarded message ----------\nFrom: Alice <alice@example\.org>/);
    expect(mail.text).toContain('Are you free on Friday?');
  });
});
