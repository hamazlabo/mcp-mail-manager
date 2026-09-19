import { describe, expect, it } from 'vitest';
import { FakeImapSession } from '../../../src/core/imap-fake';
import { NodemailerSender, SendError, type SmtpTransport, createSmtpSender } from '../../../src/core/smtp';
import type { MailConfig } from '../../../src/core/types';

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
  fromName: 'Me',
  sentFolder: 'INBOX.Sent',
  trashFolder: 'INBOX.Trash',
};

/** 呼出を記録するフェイク transport。fail が真なら sendMail が失敗する */
function fakeTransport(calls: string[], fail?: Error) {
  const sent: Record<string, unknown>[] = [];
  const transport = {
    sent,
    async sendMail(opts: Record<string, unknown>) {
      calls.push('sendMail');
      if (fail) throw fail;
      sent.push(opts);
      return { messageId: opts.messageId };
    },
  };
  return transport as typeof transport & SmtpTransport;
}

const options = { to: ['bob@example.net'], subject: 'hello', text: 'hi', messageId: '<abc@example.net>' };

describe('NodemailerSender (REQ-020)', () => {
  it('sends over SMTP and then APPENDs the same message (same Message-ID) to Sent', async () => {
    const calls: string[] = [];
    const imap = new FakeImapSession({ config });
    const transport = fakeTransport(calls);
    const sender = new NodemailerSender(config, transport);

    const result = await sender.send(options, imap);

    expect(result).toEqual({ messageId: '<abc@example.net>' });
    expect(transport.sent[0]).toMatchObject({ messageId: '<abc@example.net>', to: ['bob@example.net'] });
    expect(await imap.searchSent('<abc@example.net>')).toBe(true);
    const append = imap.calls.find((c) => c.startsWith('append('));
    expect(append).toBe('append(INBOX.Sent,["\\\\Seen"])');
    expect(calls).toEqual(['sendMail']); // APPEND は sendMail の後
    const raw = [...imap.folders.get('INBOX.Sent')!.messages.values()][0].raw.toString('utf8');
    expect(raw).toMatch(/^Message-ID: <abc@example\.net>$/m);
    expect(raw).toMatch(/^Subject: hello$/m);
  });

  it('does not APPEND and throws SendError(phase=smtp) when SMTP fails; the message never contains the password', async () => {
    const imap = new FakeImapSession({ config });
    const sender = new NodemailerSender(config, fakeTransport([], new Error(`535 auth failed for ${config.password}`)));

    const err = await sender.send(options, imap).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SendError);
    expect((err as SendError).phase).toBe('smtp');
    expect((err as SendError).message).not.toContain(config.password);
    expect(imap.calls.some((c) => c.startsWith('append('))).toBe(false);
    expect(await imap.searchSent('<abc@example.net>')).toBe(false);
  });

  it('always uses the configured From, ignoring options.from', async () => {
    const imap = new FakeImapSession({ config });
    const transport = fakeTransport([]);
    const sender = createSmtpSender(config);
    // createSmtpSender は実 transport を作るので、テストでは直接 NodemailerSender を使う
    expect(sender).toBeInstanceOf(NodemailerSender);
    await new NodemailerSender(config, transport).send({ ...options, from: 'evil@attacker.example' }, imap);

    expect(transport.sent[0].from).toEqual({ name: 'Me', address: 'me@example.net' });
    const raw = [...imap.folders.get('INBOX.Sent')!.messages.values()][0].raw.toString('utf8');
    expect(raw).toMatch(/^From: Me <me@example\.net>$/m);
    expect(raw).not.toContain('attacker');
  });

  it('throws SendError(phase=append) when SMTP succeeded but the Sent APPEND failed', async () => {
    const imap = new FakeImapSession({ config, folders: ['INBOX'] }); // Sent フォルダ無し → APPEND が NO
    const transport = fakeTransport([]);

    const err = await new NodemailerSender(config, transport).send(options, imap).catch((e: unknown) => e);

    expect(transport.sent).toHaveLength(1);
    expect(err).toBeInstanceOf(SendError);
    expect((err as SendError).phase).toBe('append');
  });
});
