/**
 * 同期 Lambda のエントリ（design.md 3.2）。EventBridge Scheduler が 15 分ごとに起動する。
 * 取込フェーズがすべてのフォルダで完了した実行でのみ照合フェーズを行う。
 */
import type { ImapSessionFactory } from '../core/imap';
import { openImapSession } from '../core/imap';
import { logger } from '../core/logger';
import { loadMailConfig } from '../core/secrets';
import { MailStore } from '../core/store';
import type { MailConfig } from '../core/types';
import { planFolder, saveFolders } from './folders';
import { ingestFolder, type SyncClock } from './ingest';
import { reconcileFolder } from './reconcile';

export interface SyncDeps {
  store: MailStore;
  loadConfig: () => Promise<MailConfig>;
  openImap: ImapSessionFactory;
  clock: SyncClock;
}

export async function runSync(deps: SyncDeps): Promise<{ complete: boolean; folders: number }> {
  const { store, clock } = deps;
  const config = await deps.loadConfig();
  const imap = await deps.openImap(config);
  try {
    const now = clock.now();
    const folders = await saveFolders({ imap, store, now });

    let complete = true;
    for (const folder of folders) {
      const plan = await planFolder({ imap, store, folder, now });
      if (plan.mode === 'reset') await store.deleteSyncState(folder);
      const result = await ingestFolder({ imap, store, folder, plan, clock });
      logger.info('sync.folder', { folder, mode: plan.mode, ...result });
      complete &&= result.complete;
    }

    if (complete) {
      for (const folder of folders) await reconcileFolder({ imap, store, folder, now: clock.now() });
    }
    return { complete, folders: folders.length };
  } finally {
    await imap.close();
  }
}

export const handler = async (_event: unknown, context: { getRemainingTimeInMillis(): number }) => {
  const store = new MailStore({ tableName: process.env.TABLE_NAME!, bucketName: process.env.BUCKET_NAME! });
  return runSync({
    store,
    loadConfig: () => loadMailConfig(),
    openImap: openImapSession,
    clock: { now: () => new Date(), remainingMs: () => context.getRemainingTimeInMillis() },
  });
};
