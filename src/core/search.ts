/**
 * 検索条件 → DynamoDB Query の組立と、同じ条件のメモリ上判定（REQ-010, design.md 4 章）。
 * 件名・差出人・宛先の部分一致は、保存時に小文字化した subjectLower / fromLower / toLower に対する contains で行う。
 */
import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { GSI2, type MessageItem } from './types';

export interface SearchInput {
  folder?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** ISO 8601。未指定なら now - 90 日 */
  since?: string;
  /** ISO 8601。未指定なら now */
  before?: string;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  /** 既定 20、上限 100 */
  limit?: number;
  cursor?: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

export function normalizeSearch(input: SearchInput, now: Date): { since: string; before: string; limit: number } {
  const since = input.since ?? new Date(now.getTime() - DEFAULT_RANGE_MS).toISOString();
  const before = input.before ?? now.toISOString();
  const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
  return { since, before, limit };
}

export function buildQuery(input: SearchInput, tableName: string, now: Date): QueryCommandInput {
  const { since, before, limit } = normalizeSearch(input, now);
  const values: Record<string, unknown> = { ':pk': 'ALL', ':from': since, ':to': `${before}￿` };
  const filters: string[] = [];

  if (input.folder !== undefined) {
    filters.push('folder = :folder');
    values[':folder'] = input.folder;
  }
  if (input.from !== undefined) {
    filters.push('contains(fromLower, :from)');
    values[':from'] = input.from.toLowerCase();
  }
  if (input.to !== undefined) {
    filters.push('contains(toLower, :to)');
    values[':to'] = input.to.toLowerCase();
  }
  if (input.subject !== undefined) {
    filters.push('contains(subjectLower, :subject)');
    values[':subject'] = input.subject.toLowerCase();
  }
  if (input.unreadOnly) {
    filters.push('seen = :false');
    values[':false'] = false;
  }
  if (input.flaggedOnly) {
    filters.push('flagged = :true');
    values[':true'] = true;
  }

  return {
    TableName: tableName,
    IndexName: GSI2,
    KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK BETWEEN :from AND :to',
    ExpressionAttributeValues: values,
    ScanIndexForward: false,
    Limit: limit,
    ...(filters.length > 0 ? { FilterExpression: filters.join(' AND ') } : {}),
    ...(input.cursor !== undefined ? { ExclusiveStartKey: decodeCursor(input.cursor) } : {}),
  };
}

/** buildQuery の FilterExpression と同じ条件をメモリ上で判定する */
export function matches(input: SearchInput): (item: MessageItem) => boolean {
  const from = input.from?.toLowerCase();
  const to = input.to?.toLowerCase();
  const subject = input.subject?.toLowerCase();
  return (item) =>
    (input.folder === undefined || item.folder === input.folder) &&
    (from === undefined || item.fromLower.includes(from)) &&
    (to === undefined || item.toLower.includes(to)) &&
    (subject === undefined || item.subjectLower.includes(subject)) &&
    (!input.unreadOnly || !item.seen) &&
    (!input.flaggedOnly || item.flagged);
}

export function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('invalid cursor');
  }
}
