import { describe, expect, it } from 'vitest';
import { deriveId, idFromLocation, idFromMessageId } from '../../../src/core/ids';

describe('ids', () => {
  it('derives the same id from the same Message-ID and folder regardless of brackets and whitespace', () => {
    const a = idFromMessageId('<abc@example.com>', 'INBOX');
    const b = idFromMessageId('  abc@example.com ', 'INBOX');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(idFromMessageId('<other@example.com>', 'INBOX')).not.toBe(a);
  });

  it('derives an id from folder / uidValidity / uid when Message-ID is missing', () => {
    const id = deriveId({ folder: 'INBOX', uidValidity: 12345, uid: 7 });
    expect(id).toBe(idFromLocation('INBOX', 12345, 7));
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveId({ folder: 'INBOX', uidValidity: 12345, uid: 8 })).not.toBe(id);
  });

  it('gives the same Message-ID a different id per folder (ADR-0006: INBOX copy and Sent copy are two records)', () => {
    const inbox = deriveId({ messageId: '<m@example.com>', folder: 'INBOX', uidValidity: 1, uid: 1 });
    const sent = deriveId({ messageId: '<m@example.com>', folder: 'INBOX.Sent', uidValidity: 2, uid: 99 });
    expect(inbox).not.toBe(sent);
    expect(inbox).toBe(idFromMessageId('<m@example.com>', 'INBOX'));
    // 同じフォルダ内なら UID / UIDVALIDITY が変わっても同じ id（再取込で上書きされる）
    expect(deriveId({ messageId: '<m@example.com>', folder: 'INBOX', uidValidity: 7, uid: 3 })).toBe(inbox);
  });

  it('treats an empty Message-ID as missing', () => {
    expect(deriveId({ messageId: '  ', folder: 'INBOX', uidValidity: 1, uid: 1 })).toBe(idFromLocation('INBOX', 1, 1));
  });
});
