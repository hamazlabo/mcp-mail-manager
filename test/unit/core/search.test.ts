import { describe, expect, it } from 'vitest';
import { buildQuery, decodeCursor, encodeCursor, matches, normalizeSearch } from '../../../src/core/search';
import type { MessageItem } from '../../../src/core/types';

const now = new Date('2026-09-19T12:00:00.000Z');

function item(overrides: Partial<MessageItem> = {}): MessageItem {
  return {
    id: 'a'.repeat(32),
    folder: 'INBOX',
    uid: 1,
    uidValidity: 1,
    subject: 'Meeting Notes',
    from: 'Alice <alice@example.com>',
    to: ['Bob <bob@example.com>'],
    cc: [],
    receivedAt: '2026-09-18T00:00:00.000Z',
    seen: false,
    flagged: false,
    hasAttachments: false,
    attachments: [],
    size: 100,
    s3Key: 'raw/a.eml',
    subjectLower: 'meeting notes',
    fromLower: 'alice <alice@example.com>',
    toLower: 'bob <bob@example.com>',
    ...overrides,
  };
}

describe('normalizeSearch', () => {
  it('defaults the date range to the last 90 days', () => {
    const n = normalizeSearch({}, now);
    expect(n.since).toBe('2026-06-21T12:00:00.000Z');
    expect(n.before).toBe('2026-09-19T12:00:00.000Z');
  });

  it('defaults limit to 20 and clamps to 1..100', () => {
    expect(normalizeSearch({}, now).limit).toBe(20);
    expect(normalizeSearch({ limit: 500 }, now).limit).toBe(100);
    expect(normalizeSearch({ limit: 0 }, now).limit).toBe(1);
    expect(normalizeSearch({ limit: 5 }, now).limit).toBe(5);
  });

  it('keeps an explicit range', () => {
    const n = normalizeSearch({ since: '2026-01-01T00:00:00.000Z', before: '2026-02-01T00:00:00.000Z' }, now);
    expect(n).toMatchObject({ since: '2026-01-01T00:00:00.000Z', before: '2026-02-01T00:00:00.000Z' });
  });
});

describe('buildQuery', () => {
  it('queries GSI2 newest-first within the date range and no filter when no condition is given', () => {
    const q = buildQuery({}, 'MailTable-dev', now);
    expect(q.TableName).toBe('MailTable-dev');
    expect(q.IndexName).toBe('GSI2');
    expect(q.ScanIndexForward).toBe(false);
    expect(q.Limit).toBe(20);
    expect(q.KeyConditionExpression).toBe('GSI2PK = :pk AND GSI2SK BETWEEN :from AND :to');
    expect(q.ExpressionAttributeValues).toMatchObject({
      ':pk': 'ALL',
      ':from': '2026-06-21T12:00:00.000Z',
      ':to': '2026-09-19T12:00:00.000Z￿',
    });
    expect(q.FilterExpression).toBeUndefined();
    expect(q.ExclusiveStartKey).toBeUndefined();
  });

  it('adds only the given conditions to the filter, lowercasing keywords', () => {
    const q = buildQuery(
      { folder: 'INBOX', from: 'ALICE', subject: 'Notes', unreadOnly: true, flaggedOnly: true, to: 'Bob' },
      'T',
      now,
    );
    expect(q.FilterExpression).toBe(
      'folder = :folder AND contains(fromLower, :from) AND contains(toLower, :to) AND contains(subjectLower, :subject) AND seen = :false AND flagged = :true',
    );
    expect(q.ExpressionAttributeValues).toMatchObject({
      ':folder': 'INBOX',
      ':from': 'alice',
      ':to': 'bob',
      ':subject': 'notes',
      ':false': false,
      ':true': true,
    });
  });

  it('round-trips the cursor into ExclusiveStartKey', () => {
    const key = { PK: 'MSG#x', SK: 'META', GSI2PK: 'ALL', GSI2SK: '2026-09-01T00:00:00.000Z#x' };
    const cursor = encodeCursor(key);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual(key);
    expect(buildQuery({ cursor }, 'T', now).ExclusiveStartKey).toEqual(key);
    expect(() => decodeCursor('!!not-base64!!')).toThrow(/invalid cursor/);
  });
});

describe('matches', () => {
  it('matches subject / from / to case-insensitively as substrings', () => {
    expect(matches({ subject: 'meeting' })(item())).toBe(true);
    expect(matches({ subject: 'MEETING NOTES' })(item())).toBe(true);
    expect(matches({ subject: 'lunch' })(item())).toBe(false);
    expect(matches({ from: 'ALICE@EXAMPLE' })(item())).toBe(true);
    expect(matches({ to: 'bob@' })(item())).toBe(true);
    expect(matches({ to: 'carol' })(item())).toBe(false);
  });

  it('applies folder / unread / flagged filters', () => {
    expect(matches({ folder: 'INBOX' })(item())).toBe(true);
    expect(matches({ folder: 'INBOX.Sent' })(item())).toBe(false);
    expect(matches({ unreadOnly: true })(item({ seen: true }))).toBe(false);
    expect(matches({ unreadOnly: true })(item({ seen: false }))).toBe(true);
    expect(matches({ flaggedOnly: true })(item({ flagged: false }))).toBe(false);
    expect(matches({ flaggedOnly: true })(item({ flagged: true }))).toBe(true);
  });
});
