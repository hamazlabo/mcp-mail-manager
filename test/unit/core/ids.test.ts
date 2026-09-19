import { describe, expect, it } from 'vitest';
import { deriveId, idFromLocation, idFromMessageId } from '../../../src/core/ids';

describe('ids', () => {
  it('derives the same id from the same Message-ID regardless of brackets and whitespace', () => {
    const a = idFromMessageId('<abc@example.com>');
    const b = idFromMessageId('  abc@example.com ');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(idFromMessageId('<other@example.com>')).not.toBe(a);
  });

  it('derives an id from folder / uidValidity / uid when Message-ID is missing', () => {
    const id = deriveId({ folder: 'INBOX', uidValidity: 12345, uid: 7 });
    expect(id).toBe(idFromLocation('INBOX', 12345, 7));
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveId({ folder: 'INBOX', uidValidity: 12345, uid: 8 })).not.toBe(id);
  });

  it('prefers Message-ID over location so a moved message keeps its id', () => {
    const inbox = deriveId({ messageId: '<m@example.com>', folder: 'INBOX', uidValidity: 1, uid: 1 });
    const archive = deriveId({ messageId: '<m@example.com>', folder: 'INBOX.Archive', uidValidity: 2, uid: 99 });
    expect(inbox).toBe(archive);
  });

  it('treats an empty Message-ID as missing', () => {
    expect(deriveId({ messageId: '  ', folder: 'INBOX', uidValidity: 1, uid: 1 })).toBe(idFromLocation('INBOX', 1, 1));
  });
});
