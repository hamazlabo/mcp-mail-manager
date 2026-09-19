import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseMessage } from '../../../src/core/mime';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)));

describe('parseMessage', () => {
  it('returns headers and the text/plain body', async () => {
    const parsed = await parseMessage(fixture('plain.eml'));
    expect(parsed.headers).toEqual({
      from: 'Alice Example <alice@example.com>',
      to: ['Bob <bob@example.net>', 'carol@example.org'],
      cc: ['Dave <dave@example.com>'],
      date: '2026-09-01T01:15:00.000Z',
      subject: 'Hello plain',
      messageId: '<plain-001@example.com>',
      inReplyTo: '<orig-000@example.net>',
      references: ['<root-000@example.net>', '<orig-000@example.net>'],
    });
    expect(parsed.text).toContain('this is the plain text body.');
    expect(parsed.attachments).toEqual([]);
  });

  it('converts an html-only message to text', async () => {
    const parsed = await parseMessage(fixture('html-only.eml'));
    expect(parsed.text).toMatch(/weekly & news/i); // html-to-text は見出しを大文字化する
    expect(parsed.text).toContain('bold');
    expect(parsed.text).toContain('Second paragraph.');
    expect(parsed.text).not.toMatch(/<[a-z]+>/i);
  });

  it('returns attachment metadata without the content', async () => {
    const parsed = await parseMessage(fixture('attachment.eml'));
    expect(parsed.text.trim()).toBe('See attached report.');
    expect(parsed.attachments).toEqual([{ filename: 'report.pdf', contentType: 'application/pdf', size: 15 }]);
    expect(Object.keys(parsed.attachments[0])).toEqual(['filename', 'contentType', 'size']);
    expect(JSON.stringify(parsed)).not.toContain('JVBERi');
  });

  it('decodes an ISO-2022-JP subject and body', async () => {
    const parsed = await parseMessage(fixture('iso-2022-jp.eml'));
    expect(parsed.headers.subject).toBe('テストの件名');
    expect(parsed.headers.from).toBe('山田太郎 <taro@example.jp>');
    expect(parsed.text).toContain('こんにちは、世界。');
    expect(parsed.text).toContain('本文です。');
  });

  it('tolerates missing optional headers', async () => {
    const parsed = await parseMessage(Buffer.from('From: x@example.com\r\nTo: y@example.com\r\n\r\nbody only\r\n'));
    expect(parsed.headers.subject).toBe('');
    expect(parsed.headers.date).toBeUndefined();
    expect(parsed.headers.messageId).toBeUndefined();
    expect(parsed.headers.inReplyTo).toBeUndefined();
    expect(parsed.headers.references).toEqual([]);
    expect(parsed.headers.cc).toEqual([]);
    expect(parsed.text.trim()).toBe('body only');
  });
});
