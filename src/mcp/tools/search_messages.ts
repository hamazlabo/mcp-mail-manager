/**
 * search_messages: DynamoDB のメタ情報に対する検索（REQ-010）。本文は返さない。
 * limit に満たない間は継続キーで最大 5 ページまで読み進める（design.md 4 章）。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildQuery, encodeCursor, normalizeSearch, type SearchInput } from '../../core/search';
import { keys, type MessageItem, type MessageSummary } from '../../core/types';
import type { ToolContext } from '../context';
import { describeError, fail, ok } from './result';

const MAX_PAGES = 5;

const inputSchema = {
  folder: z.string().optional().describe('フォルダ名（例: INBOX）'),
  from: z.string().optional().describe('差出人の部分一致（大文字小文字を区別しない）'),
  to: z.string().optional().describe('宛先の部分一致'),
  subject: z.string().optional().describe('件名の部分一致'),
  since: z.string().optional().describe('受信日時の下限（ISO 8601）。既定は 90 日前'),
  before: z.string().optional().describe('受信日時の上限（ISO 8601）。既定は現在'),
  unreadOnly: z.boolean().optional(),
  flaggedOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional().describe('件数（既定 20、最大 100）'),
  cursor: z.string().optional().describe('前回の nextCursor'),
};

function summarize(item: MessageItem): MessageSummary {
  const { id, folder, subject, from, to, receivedAt, seen, flagged, hasAttachments } = item;
  return { id, folder, subject, from, to, receivedAt, seen, flagged, hasAttachments };
}

/** GSI2 Query の ExclusiveStartKey（テーブルキー + インデックスキー）を項目から復元する */
function keyOf(item: MessageItem): Record<string, unknown> {
  return { ...keys.message(item.id), ...keys.gsi2Message(item.receivedAt, item.id) };
}

export async function searchMessages(
  ctx: ToolContext,
  input: SearchInput,
): Promise<{ messages: MessageSummary[]; nextCursor?: string }> {
  const { limit } = normalizeSearch(input, ctx.now());
  const query = buildQuery(input, ctx.store.tableName, ctx.now());
  const collected: MessageItem[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await ctx.store.queryMessages(page === 0 ? query : { ...query, ExclusiveStartKey: lastEvaluatedKey });
    collected.push(...res.items);
    lastEvaluatedKey = res.lastEvaluatedKey;
    if (collected.length >= limit || !lastEvaluatedKey) break;
  }
  const messages = collected.slice(0, limit);
  const cursorKey = collected.length > limit ? keyOf(messages[messages.length - 1]) : lastEvaluatedKey;
  return { messages: messages.map(summarize), ...(cursorKey ? { nextCursor: encodeCursor(cursorKey) } : {}) };
}

export function registerSearchMessages(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description:
        'フォルダ・差出人・宛先・件名・受信日時・未読/フラグで受信メールを検索し、受信日時の降順で一覧を返す（本文は含まない）',
      inputSchema,
    },
    async (input) => {
      try {
        return ok(await searchMessages(ctx, input));
      } catch (err) {
        return fail(describeError(err));
      }
    },
  );
}
