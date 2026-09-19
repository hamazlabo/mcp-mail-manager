/**
 * scheduled-send Lambda（design.md 3.3、ADR-0003）。EventBridge Scheduler から `{ scheduleId }` で起動される。
 * pending → sending を条件付きで取れた実行だけが SMTP 送信と Sent APPEND を行う（REQ-042: ちょうど 1 回）。
 * SMTP 未送信の失敗は pending に戻して再スロー（Scheduler が最大 3 回再試行）、3 回目で failed（REQ-043）。
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildNew } from '../core/compose';
import { openImapSession, type ImapSessionFactory } from '../core/imap';
import { logger } from '../core/logger';
import { emitScheduledSendFailed } from '../core/metrics';
import { claimSending, markFailed, markSent, releaseToPending, type ScheduledContext } from '../core/scheduled';
import { loadMailConfig } from '../core/secrets';
import { SendError, createSmtpSender, type SendOptions, type SmtpSenderFactory } from '../core/smtp';
import type { MailConfig, ScheduledItem } from '../core/types';

/** Scheduler の再試行を含めた送信試行の上限（REQ-043） */
const MAX_ATTEMPTS = 3;
/** これより新しい sending は別の実行が進行中とみなす。scheduled-send Lambda のタイムアウト以上にすること */
const IN_FLIGHT_MS = 5 * 60_000;

export interface ScheduledSendDeps {
  ddb: DynamoDBDocumentClient;
  tableName: string;
  loadConfig: () => Promise<MailConfig>;
  openImap: ImapSessionFactory;
  createSmtp: SmtpSenderFactory;
  now: () => Date;
  stage: string;
}

export interface ScheduledSendEvent {
  scheduleId: string;
}

export function createHandler(deps: ScheduledSendDeps): (event: ScheduledSendEvent) => Promise<void> {
  const ctx: ScheduledContext = { ddb: deps.ddb, tableName: deps.tableName };

  return async ({ scheduleId }) => {
    const claim = await claimSending(ctx, scheduleId, deps.now());
    if (!claim.claimed) {
      if (claim.status === 'sending' && claim.item && !inFlight(claim.item, deps.now())) {
        await resolveUnknownDelivery(deps, ctx, claim.item);
      } else {
        logger.info('scheduled_send.skipped', { scheduleId, status: claim.status });
      }
      return;
    }
    await sendClaimed(deps, ctx, claim.item);
  };
}

async function sendClaimed(deps: ScheduledSendDeps, ctx: ScheduledContext, item: ScheduledItem): Promise<void> {
  const { scheduleId } = item;
  const config = await deps.loadConfig();
  try {
    const options = buildNew({ config, ...item, messageId: item.messageId }) as SendOptions;
    const imap = await deps.openImap(config);
    try {
      await deps.createSmtp(config).send(options, imap);
    } finally {
      await imap.close();
    }
  } catch (err) {
    if (err instanceof SendError && err.phase === 'append') {
      // 送信済み。再送はせず、Sent に残らなかった旨だけ記録する
      await markSent(ctx, scheduleId, deps.now(), 'sent-but-append-failed');
      logger.warn('scheduled_send.append_failed', { scheduleId, messageId: item.messageId, error: err.message });
      return;
    }
    const reason = describe(err, config);
    if (item.attempts >= MAX_ATTEMPTS) {
      await markFailed(ctx, scheduleId, reason, deps.now());
      emitScheduledSendFailed(deps.stage);
      logger.error('scheduled_send.failed', { scheduleId, attempts: item.attempts, error: reason });
      return;
    }
    await releaseToPending(ctx, scheduleId, deps.now());
    logger.warn('scheduled_send.retry', { scheduleId, attempts: item.attempts, error: reason });
    throw err;
  }
  await markSent(ctx, scheduleId, deps.now());
  logger.info('scheduled_send.sent', { scheduleId, messageId: item.messageId });
}

/** 前回の実行が sending のまま終わった（結果不明）。Sent に Message-ID があれば sent、無ければ failed。再送しない */
async function resolveUnknownDelivery(deps: ScheduledSendDeps, ctx: ScheduledContext, item: ScheduledItem): Promise<void> {
  const { scheduleId } = item;
  const config = await deps.loadConfig();
  const imap = await deps.openImap(config);
  let found: boolean;
  try {
    found = await imap.searchSent(item.messageId);
  } finally {
    await imap.close();
  }
  if (found) {
    await markSent(ctx, scheduleId, deps.now());
    logger.info('scheduled_send.recovered_as_sent', { scheduleId, messageId: item.messageId });
    return;
  }
  await markFailed(ctx, scheduleId, 'unknown-delivery', deps.now());
  emitScheduledSendFailed(deps.stage);
  logger.error('scheduled_send.failed', { scheduleId, error: 'unknown-delivery' });
}

/** 同時重複発火: claim が最近なら別の実行が送信中なので触らない（結果不明の判定は古い sending だけ） */
function inFlight(item: ScheduledItem, now: Date): boolean {
  return item.updatedAt !== undefined && now.getTime() - new Date(item.updatedAt).getTime() < IN_FLIGHT_MS;
}

/** 失敗理由を 1 行にする。パスワードは伏せる（REQ-052） */
function describe(err: unknown, config: MailConfig): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.split(config.password).join('***');
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`environment variable ${name} is not set`);
  return value;
}

/** Lambda のエントリ。依存は環境変数（TABLE_NAME / MAIL_SECRET_ARN / STAGE）から組む */
export const handler = (event: ScheduledSendEvent): Promise<void> =>
  createHandler({
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
    tableName: env('TABLE_NAME'),
    loadConfig: () => loadMailConfig({ secretId: env('MAIL_SECRET_ARN') }),
    openImap: openImapSession,
    createSmtp: createSmtpSender,
    now: () => new Date(),
    stage: env('STAGE'),
  })(event);
