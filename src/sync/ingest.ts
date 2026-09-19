/**
 * 同期: 取込フェーズ（design.md 3.2 手順 2、REQ-001 / REQ-004）。
 * 対象 UID を 50 通ずつ取得して S3 と DynamoDB に保存し、バッチごとに lastUid を進める。
 * 残り時間が予算を切ったら中断し、次回は lastUid+1 から再開する。
 */
import { deriveId } from '../core/ids';
import type { ImapMessage, ImapSession } from '../core/imap';
import { logger } from '../core/logger';
import { parseMessage } from '../core/mime';
import type { MailStore } from '../core/store';
import { rawKey } from '../core/types';
import type { FolderPlan } from './folders';

export interface SyncClock {
  now(): Date;
  /** 実行時間の残り（ミリ秒）。Lambda では context.getRemainingTimeInMillis() */
  remainingMs(): number;
}

/** これより残り時間が少なければ次のバッチに入らず中断する（REQ-004） */
export const TIME_BUDGET_MS = 60_000;

export async function ingestFolder(input: {
  imap: ImapSession;
  store: MailStore;
  folder: string;
  plan: FolderPlan;
  clock: SyncClock;
  batchSize?: number;
}): Promise<{ complete: boolean; ingested: number }> {
  const { imap, store, folder, plan, clock, batchSize = 50 } = input;

  const uids = await targetUids(imap, folder, plan);
  let lastUid = plan.mode === 'reset' ? 0 : (plan.uidFrom ?? 1) - 1;
  let ingested = 0;

  for (let i = 0; i < uids.length; i += batchSize) {
    if (clock.remainingMs() < TIME_BUDGET_MS) {
      logger.warn('sync.ingest.suspended', { folder, lastUid, remaining: uids.length - i });
      return { complete: false, ingested };
    }
    const batch = uids.slice(i, i + batchSize);
    for (const message of await imap.fetchMessages(folder, batch)) {
      if (message.deleted) continue;
      await ingestMessage(store, folder, plan.uidValidity, message);
      ingested++;
    }
    lastUid = batch[batch.length - 1];
    await saveState(store, folder, plan.uidValidity, lastUid, false, clock);
    logger.info('sync.ingest.batch', { folder, count: batch.length, lastUid });
  }

  await saveState(store, folder, plan.uidValidity, lastUid, true, clock);
  return { complete: true, ingested };
}

/** 取込対象の UID（昇順）。初回は SINCE 90 日、差分は uidFrom 以降。初回の再開は uidFrom 未満を除く */
async function targetUids(imap: ImapSession, folder: string, plan: FolderPlan): Promise<number[]> {
  const uids =
    plan.mode === 'incremental'
      ? await imap.searchUids(folder, { uidFrom: plan.uidFrom })
      : await imap.searchUids(folder, { since: plan.since });
  const from = plan.mode === 'initial' ? plan.uidFrom : undefined;
  return uids.filter((uid) => from === undefined || uid >= from).sort((a, b) => a - b);
}

async function ingestMessage(store: MailStore, folder: string, uidValidity: number, message: ImapMessage): Promise<void> {
  const parsed = await parseMessage(message.raw);
  const id = deriveId({ messageId: parsed.headers.messageId, folder, uidValidity, uid: message.uid });
  await store.putRaw(id, message.raw);
  await store.putMessage({
    id,
    messageId: parsed.headers.messageId,
    folder,
    uid: message.uid,
    uidValidity,
    subject: parsed.headers.subject,
    from: parsed.headers.from,
    to: parsed.headers.to,
    cc: parsed.headers.cc,
    receivedAt: message.internalDate.toISOString(),
    seen: message.seen,
    flagged: message.flagged,
    hasAttachments: parsed.attachments.length > 0,
    attachments: parsed.attachments,
    size: message.raw.length,
    s3Key: rawKey(id),
    subjectLower: '',
    fromLower: '',
    toLower: '',
  });
}

function saveState(
  store: MailStore,
  folder: string,
  uidValidity: number,
  lastUid: number,
  initialDone: boolean,
  clock: SyncClock,
): Promise<void> {
  return store.putSyncState({ folder, uidValidity, lastUid, initialDone, updatedAt: clock.now().toISOString() });
}
