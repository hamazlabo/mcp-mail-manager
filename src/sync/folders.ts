/**
 * 同期: フォルダ列挙と取込モードの判定（design.md 3.2 手順 1〜2、REQ-001 / REQ-002 / REQ-004）。
 */
import type { ImapSession } from '../core/imap';
import type { MailStore } from '../core/store';
import type { FolderItem } from '../core/types';

/** 初回同期の取込範囲（REQ-002） */
export const INITIAL_DAYS = 90;

export type FolderPlan =
  /** 初回（SyncState 無し）。途中再開なら uidFrom を持つ */
  | { mode: 'initial'; uidValidity: number; since: Date; uidFrom?: number }
  /** UIDVALIDITY が変わった: SyncState を捨てて初回扱い */
  | { mode: 'reset'; uidValidity: number; since: Date }
  /** 差分: lastUid+1 以降 */
  | { mode: 'incremental'; uidValidity: number; uidFrom: number };

export async function planFolder(input: {
  imap: ImapSession;
  store: MailStore;
  folder: string;
  now: Date;
}): Promise<FolderPlan> {
  const { uidValidity } = await input.imap.select(input.folder);
  const state = await input.store.getSyncState(input.folder);
  const since = new Date(input.now.getTime() - INITIAL_DAYS * 86_400_000);

  if (!state) return { mode: 'initial', uidValidity, since };
  if (state.uidValidity !== uidValidity) return { mode: 'reset', uidValidity, since };
  if (!state.initialDone) return { mode: 'initial', uidValidity, since, uidFrom: state.lastUid + 1 };
  return { mode: 'incremental', uidValidity, uidFrom: state.lastUid + 1 };
}

/** 全フォルダを Folder アイテムとして保存する。total / unread は既存値を維持（照合フェーズが更新する）。 */
export async function saveFolders(input: { imap: ImapSession; store: MailStore; now: Date }): Promise<string[]> {
  const [folders, special, existing] = await Promise.all([
    input.imap.listFolders(),
    input.imap.specialFolders(),
    input.store.listFolders(),
  ]);
  const known = new Map(existing.map((f) => [f.name, f]));

  for (const folder of folders) {
    const item: FolderItem = {
      name: folder.name,
      delimiter: folder.delimiter,
      specialUse:
        folder.specialUse ?? (folder.name === special.sent ? 'sent' : folder.name === special.trash ? 'trash' : undefined),
      total: known.get(folder.name)?.total ?? 0,
      unread: known.get(folder.name)?.unread ?? 0,
      lastSyncAt: known.get(folder.name)?.lastSyncAt ?? input.now.toISOString(),
    };
    await input.store.putFolder(item);
  }
  return folders.map((f) => f.name);
}
