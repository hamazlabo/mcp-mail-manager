import { describe, expect, it } from 'vitest';
import { buildForward, buildNew, buildReply, newMessageId } from '../../../src/core/compose';
import type { MailConfig, ParsedMessage } from '../../../src/core/types';

const config: MailConfig = {
  domain: 'example.net',
  user: 'me',
  address: 'me@example.net',
  password: 'secret',
  imapHost: 'mx.example.net',
  imapPort: 993,
  smtpHost: 'mx.example.net',
  smtpPort: 587,
  smtpSecure: false,
  fromName: 'Me',
  sentFolder: 'INBOX.Sent',
  trashFolder: 'INBOX.Trash',
};

const original: ParsedMessage = {
  headers: {
    from: 'Alice <alice@example.com>',
    to: ['Me <me@example.net>', 'Bob <bob@example.org>'],
    cc: ['carol@example.org'],
    date: '2026-09-01T01:15:00.000Z',
    subject: 'Hello',
    messageId: '<orig-1@example.com>',
    inReplyTo: undefined,
    references: ['<root-0@example.com>'],
  },
  text: 'original body',
  attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', size: 12288 }],
};

const withHeaders = (h: Partial<ParsedMessage['headers']>): ParsedMessage => ({
  ...original,
  headers: { ...original.headers, ...h },
});

describe('newMessageId', () => {
  it('returns <uuid@domain>', () => {
    expect(newMessageId('example.net')).toMatch(/^<[0-9a-f-]{36}@example\.net>$/);
  });
});

describe('buildNew', () => {
  it('builds a plain-text message with the fixed From and given Message-ID', () => {
    const m = buildNew({
      config,
      to: ['Bob <bob@example.org>'],
      cc: ['carol@example.org'],
      subject: 'Hi',
      body: 'text body',
      messageId: '<id-1@example.net>',
    });
    expect(m.from).toEqual({ name: 'Me', address: 'me@example.net' });
    expect(m.to).toEqual(['Bob <bob@example.org>']);
    expect(m.cc).toEqual(['carol@example.org']);
    expect(m.bcc).toBeUndefined();
    expect(m.subject).toBe('Hi');
    expect(m.text).toBe('text body');
    expect(m.html).toBeUndefined();
    expect(m.messageId).toBe('<id-1@example.net>');
  });

  it('uses a bare From address when fromName is not set', () => {
    const m = buildNew({ config: { ...config, fromName: undefined }, to: ['bob@example.org'], subject: 's', body: 'b', messageId: '<x@example.net>' });
    expect(m.from).toBe('me@example.net');
  });

  it('rejects empty or malformed recipients', () => {
    const base = { config, subject: 's', body: 'b', messageId: '<x@example.net>' };
    expect(() => buildNew({ ...base, to: [] })).toThrow(/recipient/);
    expect(() => buildNew({ ...base, to: ['not-an-address'] })).toThrow('invalid recipient: not-an-address');
    expect(() => buildNew({ ...base, to: ['ok@example.org'], cc: ['bad@'] })).toThrow('invalid recipient: bad@');
    expect(() => buildNew({ ...base, to: ['ok@example.org'], bcc: ['Name <nope>'] })).toThrow('invalid recipient: Name <nope>');
  });
});

describe('buildReply', () => {
  it('threads with In-Reply-To / References and prefixes Re:', () => {
    const m = buildReply({ config, original, body: 'thanks', messageId: '<r-1@example.net>' });
    expect(m.inReplyTo).toBe('<orig-1@example.com>');
    expect(m.references).toEqual(['<root-0@example.com>', '<orig-1@example.com>']);
    expect(m.subject).toBe('Re: Hello');
    expect(m.to).toEqual(['Alice <alice@example.com>']);
    expect(m.cc).toBeUndefined();
    expect(m.text).toBe('thanks');
    expect(m.from).toEqual({ name: 'Me', address: 'me@example.net' });
    expect(m.messageId).toBe('<r-1@example.net>');
  });

  it('does not stack Re: prefixes', () => {
    const m = buildReply({ config, original: withHeaders({ subject: 'RE: Hello' }), body: 'x', messageId: '<r@example.net>' });
    expect(m.subject).toBe('RE: Hello');
  });

  it('reply-all includes To/Cc, excludes self (case-insensitive) and duplicates', () => {
    const m = buildReply({
      config,
      original: withHeaders({ to: ['ME@Example.net', 'Bob <bob@example.org>', 'alice@example.com'] }),
      body: 'x',
      replyAll: true,
      messageId: '<r@example.net>',
    });
    expect(m.to).toEqual(['Alice <alice@example.com>', 'Bob <bob@example.org>']);
    expect(m.cc).toEqual(['carol@example.org']);
  });

  it('replies to the original To when the original was sent by self', () => {
    const m = buildReply({
      config,
      original: withHeaders({ from: 'Me <me@example.net>', to: ['Bob <bob@example.org>'] }),
      body: 'x',
      messageId: '<r@example.net>',
    });
    expect(m.to).toEqual(['Bob <bob@example.org>']);
  });
});

describe('buildForward', () => {
  it('prefixes Fwd:, quotes the original and notes attachments', () => {
    const m = buildForward({ config, original, to: ['dave@example.org'], comment: 'FYI', messageId: '<f@example.net>' });
    expect(m.subject).toBe('Fwd: Hello');
    expect(m.to).toEqual(['dave@example.org']);
    expect(m.text).toBe(
      [
        'FYI',
        '',
        '---------- Forwarded message ----------',
        'From: Alice <alice@example.com>',
        'Date: 2026-09-01T01:15:00.000Z',
        'Subject: Hello',
        'To: Me <me@example.net>, Bob <bob@example.org>',
        '',
        'original body',
        '',
        '添付ファイル 1 件は転送されません: a.pdf (12 KB)',
      ].join('\n'),
    );
    expect(m.inReplyTo).toBeUndefined();
    expect(m.messageId).toBe('<f@example.net>');
  });

  it('omits the comment and attachment note when absent, and does not stack Fwd:', () => {
    const m = buildForward({
      config,
      original: { ...withHeaders({ subject: 'FW: Hello' }), attachments: [] },
      to: ['dave@example.org'],
      messageId: '<f@example.net>',
    });
    expect(m.subject).toBe('FW: Hello');
    expect(m.text).toMatch(/^---------- Forwarded message ----------\n/);
    expect(m.text).not.toContain('添付ファイル');
  });

  it('requires recipients', () => {
    expect(() => buildForward({ config, original, to: [], messageId: '<f@example.net>' })).toThrow(/recipient/);
  });
});
