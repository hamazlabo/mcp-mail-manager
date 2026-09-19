/**
 * 同期: 照合フェーズとフォルダ集計（design.md 3.2 手順 3〜4、REQ-003 / REQ-012）。
 * DynamoDB の既知 UID 集合と IMAP の FLAGS を突き合わせ、フラグ差分を反映し、
 * IMAP に無い・\Deleted 付きのメッセージを削除する。他フォルダで再登録済み（移動）のものは残す。
 */
import type { ImapSession } from '../core/imap';
import { logger } from '../core/logger';
import type { MailStore } from '../core/store';

export async function reconcileFolder(input: {
  imap: ImapSession;
  store: MailStore;
  folder: string;
  now: Date;
}): Promise<void> {
  const { imap, store, folder, now } = input;
  const known = await store.listFolderUids(folder);
  const minUid = known.length === 0 ? 1 : Math.min(...known.map((k) => k.uid));
  const flags = await imap.fetchFlags(folder, minUid);
  const byUid = new Map(flags.map((f) => [f.uid, f]));

  let updated = 0;
  let removed = 0;
  for (const k of known) {
    const f = byUid.get(k.uid);
    if (f && !f.deleted) {
      const diff = { ...(f.seen !== k.seen && { seen: f.seen }), ...(f.flagged !== k.flagged && { flagged: f.flagged }) };
      if (Object.keys(diff).length === 0) continue;
      await store.updateFlags(k.id, diff);
      updated++;
      continue;
    }
    // GSI は結果整合のため、取込フェーズで他フォルダに再登録された直後は古い所属が見えることがある。
    // 実体の所属が今のフォルダ / UID のときだけ消す（移動されたメッセージを消さない）。
    const item = await store.getMessage(k.id);
    if (!item || item.folder !== folder || item.uid !== k.uid) continue;
    await store.deleteMessage(k.id);
    // ツールで移動したレコードは元 id の生メッセージを参照しているので、id ではなく s3Key で消す
    await store.deleteRawKey(item.s3Key);
    removed++;
  }

  const live = flags.filter((f) => !f.deleted);
  const existing = (await store.listFolders()).find((f) => f.name === folder);
  await store.putFolder({
    ...(existing ?? { name: folder, delimiter: '.' }),
    total: live.length,
    unread: live.filter((f) => !f.seen).length,
    lastSyncAt: now.toISOString(),
  });
  logger.info('sync.reconcile', { folder, known: known.length, updated, removed, total: live.length });
}
