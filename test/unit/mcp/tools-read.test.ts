import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../../src/core/search';
import type { FolderItem, MessageItem } from '../../../src/core/types';
import { registerGetMessage } from '../../../src/mcp/tools/get_message';
import { registerListFolders } from '../../../src/mcp/tools/list_folders';
import { registerSearchMessages } from '../../../src/mcp/tools/search_messages';
import { call, connect, json, makeCtx, text } from './helpers';

function message(n: number, extra: Record<string, unknown> = {}): MessageItem {
  return {
    id: `id${n}`,
    messageId: `<m${n}@example.com>`,
    folder: 'INBOX',
    uid: n,
    uidValidity: 1,
    subject: `Subject ${n}`,
    from: `Alice <alice@example.com>`,
    to: ['me@example.net'],
    cc: [],
    receivedAt: `2026-09-1${n}T00:00:00.000Z`,
    seen: false,
    flagged: false,
    hasAttachments: false,
    attachments: [],
    size: 100,
    s3Key: `raw/id${n}.eml`,
    subjectLower: `subject ${n}`,
    fromLower: 'alice <alice@example.com>',
    toLower: 'me@example.net',
    ...(extra as Partial<MessageItem>),
  };
}

const SUMMARY_KEYS = ['id', 'folder', 'subject', 'from', 'to', 'receivedAt', 'seen', 'flagged', 'hasAttachments'].sort();

describe('list_folders (REQ-012)', () => {
  it('returns name / total / unread / specialUse of synced folders', async () => {
    const folders: FolderItem[] = [
      { name: 'INBOX', delimiter: '.', total: 10, unread: 3, lastSyncAt: '2026-09-19T00:00:00Z' },
      { name: 'INBOX.Sent', delimiter: '.', specialUse: 'sent', total: 4, unread: 0, lastSyncAt: '2026-09-19T00:00:00Z' },
    ];
    const ctx = makeCtx({ store: { listFolders: async () => folders } });
    const client = await connect((s) => registerListFolders(s, ctx));
    expect(json(await call(client, 'list_folders'))).toEqual([
      { name: 'INBOX', total: 10, unread: 3, specialUse: undefined },
      { name: 'INBOX.Sent', total: 4, unread: 0, specialUse: 'sent' },
    ]);
  });
});

describe('search_messages (REQ-010)', () => {
  it('returns summaries without body or internal attributes', async () => {
    const ctx = makeCtx({
      store: {
        tableName: 'MailTable-test',
        queryMessages: async () => ({ items: [message(1, { text: 'SECRET BODY' } as never), message(2)] }),
      },
    });
    const client = await connect((s) => registerSearchMessages(s, ctx));
    const result = json<{ messages: Record<string, unknown>[]; nextCursor?: string }>(
      await call(client, 'search_messages', { subject: 'subject' }),
    );
    expect(result.messages).toHaveLength(2);
    expect(Object.keys(result.messages[0]).sort()).toEqual(SUMMARY_KEYS);
    expect(JSON.stringify(result)).not.toContain('SECRET BODY');
    expect(result.nextCursor).toBeUndefined();
  });

  it('returns an empty list (not an error) when nothing matches', async () => {
    const ctx = makeCtx({ store: { tableName: 't', queryMessages: async () => ({ items: [] }) } });
    const client = await connect((s) => registerSearchMessages(s, ctx));
    const result = await call(client, 'search_messages');
    expect(result.isError).toBeFalsy();
    expect(json(result)).toEqual({ messages: [] });
  });

  it('reads further pages until limit is reached and returns a cursor for the rest', async () => {
    const queries: QueryCommandInput[] = [];
    const pages = [
      { items: [message(1)], lastEvaluatedKey: { PK: 'MSG#id1', SK: 'META', GSI2PK: 'ALL', GSI2SK: 'x' } },
      { items: [message(2), message(3)], lastEvaluatedKey: { PK: 'MSG#id3', SK: 'META', GSI2PK: 'ALL', GSI2SK: 'y' } },
    ];
    const ctx = makeCtx({
      store: {
        tableName: 't',
        queryMessages: async (q: QueryCommandInput) => {
          queries.push(q);
          return pages[queries.length - 1];
        },
      },
    });
    const client = await connect((s) => registerSearchMessages(s, ctx));
    const result = json<{ messages: { id: string }[]; nextCursor?: string }>(
      await call(client, 'search_messages', { limit: 2 }),
    );
    expect(result.messages.map((m) => m.id)).toEqual(['id1', 'id2']);
    expect(queries).toHaveLength(2);
    expect(queries[1].ExclusiveStartKey).toEqual(pages[0].lastEvaluatedKey);
    // 続きは 2 件目（返した最後の項目）のキーから
    expect(decodeCursor(result.nextCursor!)).toMatchObject({ PK: 'MSG#id2', SK: 'META', GSI2PK: 'ALL' });
  });

  it('passes a cursor through and rejects an invalid one', async () => {
    const queries: QueryCommandInput[] = [];
    const ctx = makeCtx({
      store: {
        tableName: 't',
        queryMessages: async (q: QueryCommandInput) => {
          queries.push(q);
          return { items: [] };
        },
      },
    });
    const client = await connect((s) => registerSearchMessages(s, ctx));
    const key = { PK: 'MSG#id9', SK: 'META', GSI2PK: 'ALL', GSI2SK: 'z' };
    json(await call(client, 'search_messages', { cursor: encodeCursor(key) }));
    expect(queries[0].ExclusiveStartKey).toEqual(key);

    const bad = await call(client, 'search_messages', { cursor: '***' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('invalid cursor');
  });
});

describe('get_message (REQ-011)', () => {
  const raw = readFileSync(join(__dirname, '../../fixtures/html-only.eml'));

  it('fails with "not found" for an unknown id', async () => {
    const ctx = makeCtx({ store: { getMessage: async () => undefined, getRaw: async () => raw } });
    const client = await connect((s) => registerGetMessage(s, ctx));
    const result = await call(client, 'get_message', { id: 'nope' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('message not found: nope');
  });

  it('returns headers, text (html converted) and attachment metadata', async () => {
    const ctx = makeCtx({ store: { getMessage: async () => message(1), getRaw: async () => raw } });
    const client = await connect((s) => registerGetMessage(s, ctx));
    const result = json<{ id: string; headers: { subject: string; messageId?: string }; text: string; attachments: unknown[] }>(
      await call(client, 'get_message', { id: 'id1' }),
    );
    expect(result.id).toBe('id1');
    expect(result.headers.subject).toBe('Newsletter');
    expect(result.headers.messageId).toBe('<html-001@example.com>');
    expect(result.text).toMatch(/weekly & news/i);
    expect(result.text).not.toMatch(/<[a-z]+>/i);
    expect(result.attachments).toEqual([]);
  });
});
