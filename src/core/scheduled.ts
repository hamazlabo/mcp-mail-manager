/**
 * 予約送信の状態遷移（design.md 3.3、ADR-0003）。
 * pending → sending → sent | failed、pending → cancelled を DynamoDB の条件付き更新で行う。
 * 終端状態（sent / failed / cancelled）には ttl（+90 日）を付ける（NFR-002）。
 */
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { stripKeys } from './store';
import { keys, type ScheduledItem, type ScheduledStatus } from './types';

export interface ScheduledContext {
  ddb: DynamoDBDocumentClient;
  tableName: string;
}

export type ClaimResult =
  | { claimed: true; item: ScheduledItem }
  | { claimed: false; status: ScheduledStatus | 'missing'; item?: ScheduledItem };

export type CancelResult = { cancelled: true } | { cancelled: false; status: ScheduledStatus | 'missing' };

const YEAR_MS = 365 * 86400 * 1000;
const TERMINAL_TTL_SECONDS = 90 * 86400;
const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** REQ-040: タイムゾーン付き ISO 8601、現在より後、1 年以内。 */
export function validateSendAt(sendAt: string, now: Date): Date {
  if (!ISO_WITH_TZ.test(sendAt)) throw new Error(`sendAt must be ISO 8601 with a timezone (e.g. 2026-10-01T18:00:00+09:00): ${sendAt}`);
  const date = new Date(sendAt);
  if (Number.isNaN(date.getTime())) throw new Error(`sendAt is not a valid ISO 8601 time: ${sendAt}`);
  if (date.getTime() <= now.getTime()) throw new Error(`sendAt is in the past: ${sendAt}`);
  if (date.getTime() > now.getTime() + YEAR_MS) throw new Error(`sendAt is more than one year ahead: ${sendAt}`);
  return date;
}

function terminalTtl(now: Date): number {
  return Math.floor(now.getTime() / 1000) + TERMINAL_TTL_SECONDS;
}

function isConditionFailed(err: unknown): boolean {
  return (err as { name?: string }).name === 'ConditionalCheckFailedException';
}

async function getCurrent(ctx: ScheduledContext, scheduleId: string): Promise<ScheduledItem | undefined> {
  const res = await ctx.ddb.send(new GetCommand({ TableName: ctx.tableName, Key: keys.scheduled(scheduleId) }));
  return res.Item ? stripKeys<ScheduledItem>(res.Item) : undefined;
}

/** pending → sending。成功した呼出だけが送信してよい（REQ-042: ちょうど 1 回）。 */
export async function claimSending(ctx: ScheduledContext, scheduleId: string, now: Date): Promise<ClaimResult> {
  try {
    const res = await ctx.ddb.send(
      new UpdateCommand({
        TableName: ctx.tableName,
        Key: keys.scheduled(scheduleId),
        ConditionExpression: '#status = :pending',
        UpdateExpression: 'SET #status = :sending, #attempts = #attempts + :one, #updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status', '#attempts': 'attempts', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':pending': 'pending', ':sending': 'sending', ':one': 1, ':now': now.toISOString() },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return { claimed: true, item: stripKeys<ScheduledItem>(res.Attributes ?? {}) };
  } catch (err) {
    if (!isConditionFailed(err)) throw err;
    const item = await getCurrent(ctx, scheduleId);
    return { claimed: false, status: item?.status ?? 'missing', item };
  }
}

async function markTerminal(
  ctx: ScheduledContext,
  scheduleId: string,
  status: 'sent' | 'failed',
  now: Date,
  error?: string,
): Promise<void> {
  await ctx.ddb.send(
    new UpdateCommand({
      TableName: ctx.tableName,
      Key: keys.scheduled(scheduleId),
      UpdateExpression: `SET #status = :status, #ttl = :ttl, #updatedAt = :now${error === undefined ? '' : ', #error = :error'}`,
      ExpressionAttributeNames: {
        '#status': 'status',
        '#ttl': 'ttl',
        '#updatedAt': 'updatedAt',
        ...(error !== undefined && { '#error': 'error' }),
      },
      ExpressionAttributeValues: {
        ':status': status,
        ':ttl': terminalTtl(now),
        ':now': now.toISOString(),
        ...(error !== undefined && { ':error': error }),
      },
    }),
  );
}

export function markSent(ctx: ScheduledContext, scheduleId: string, now: Date): Promise<void> {
  return markTerminal(ctx, scheduleId, 'sent', now);
}

/** REQ-043: 失敗理由を保存する。 */
export function markFailed(ctx: ScheduledContext, scheduleId: string, error: string, now: Date): Promise<void> {
  return markTerminal(ctx, scheduleId, 'failed', now, error);
}

/** REQ-041: pending 以外は取り消せない。例外にせず現在状態を返す。 */
export async function cancelScheduled(ctx: ScheduledContext, scheduleId: string, now: Date): Promise<CancelResult> {
  try {
    await ctx.ddb.send(
      new UpdateCommand({
        TableName: ctx.tableName,
        Key: keys.scheduled(scheduleId),
        ConditionExpression: '#status = :pending',
        UpdateExpression: 'SET #status = :status, #ttl = :ttl, #updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':pending': 'pending', ':status': 'cancelled', ':ttl': terminalTtl(now), ':now': now.toISOString() },
      }),
    );
    return { cancelled: true };
  } catch (err) {
    if (!isConditionFailed(err)) throw err;
    const item = await getCurrent(ctx, scheduleId);
    return { cancelled: false, status: item?.status ?? 'missing' };
  }
}
