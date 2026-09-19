import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger, redact } from '../../../src/core/logger';

describe('logger', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never prints the value of password / authorization / body / text / raw keys, even nested', () => {
    logger.info('imap.connect', {
      host: 'example.sakura.ne.jp',
      password: 'S3cret!',
      Authorization: 'Bearer tok',
      nested: { body: 'mail body', text: 'plain', raw: 'raw' },
    });
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).not.toContain('S3cret!');
    expect(line).not.toContain('Bearer tok');
    expect(line).not.toContain('mail body');
    expect(line).not.toContain('plain');
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({
      level: 'info',
      event: 'imap.connect',
      host: 'example.sakura.ne.jp',
      password: '[redacted]',
      nested: { body: '[redacted]', text: '[redacted]', raw: '[redacted]' },
    });
    expect(typeof parsed.time).toBe('string');
  });

  it('serializes errors as name and message without stack', () => {
    logger.error('sync.failed', { error: new Error('boom') });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe('error');
    expect(parsed.error).toEqual({ name: 'Error', message: 'boom' });
    expect(lines[0]).not.toContain('at ');
  });

  it('redact leaves other values untouched and handles arrays', () => {
    expect(redact({ list: [{ password: 'x', ok: 1 }], n: 2 })).toEqual({ list: [{ password: '[redacted]', ok: 1 }], n: 2 });
    expect(redact('plain string')).toBe('plain string');
  });
});
