/**
 * sync テスト用のメモリ上 MailStore。必要なメソッドだけを持ち、`as unknown as MailStore` で渡す。
 */
import type { MailStore } from '../../../src/core/store';
import type { FolderItem, MessageItem, SyncStateItem } from '../../../src/core/types';

export class FakeStore {
  readonly messages = new Map<string, MessageItem>();
  readonly raws = new Map<string, Buffer>();
  readonly folders = new Map<string, FolderItem>();
  readonly syncStates = new Map<string, SyncStateItem>();
  /** putSyncState の履歴（lastUid の進み方を検証する） */
  readonly syncStateHistory: SyncStateItem[] = [];
  readonly calls: string[] = [];

  async getSyncState(folder: string) {
    return this.syncStates.get(folder);
  }
  async putSyncState(item: SyncStateItem) {
    this.calls.push(`putSyncState(${item.folder},${item.lastUid},${item.initialDone})`);
    this.syncStates.set(item.folder, { ...item });
    this.syncStateHistory.push({ ...item });
  }
  async deleteSyncState(folder: string) {
    this.calls.push(`deleteSyncState(${folder})`);
    this.syncStates.delete(folder);
  }
  async putRaw(id: string, raw: Buffer) {
    this.calls.push(`putRaw(${id})`);
    this.raws.set(id, raw);
  }
  /** 実装は S3 キーで消す。フェイクの raws は id をキーにしているので `raw/<id>.eml` から id を戻す */
  async deleteRawKey(key: string) {
    this.calls.push(`deleteRawKey(${key})`);
    this.raws.delete(key.replace(/^raw\//, '').replace(/\.eml$/, ''));
  }
  async putMessage(item: MessageItem) {
    this.calls.push(`putMessage(${item.id})`);
    this.messages.set(item.id, { ...item });
  }
  async getMessage(id: string) {
    return this.messages.get(id);
  }
  async deleteMessage(id: string) {
    this.calls.push(`deleteMessage(${id})`);
    this.messages.delete(id);
  }
  async updateFlags(id: string, flags: { seen?: boolean; flagged?: boolean }) {
    this.calls.push(`updateFlags(${id},${JSON.stringify(flags)})`);
    const m = this.messages.get(id);
    if (m) Object.assign(m, Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined)));
  }
  async listFolderUids(folder: string) {
    return [...this.messages.values()]
      .filter((m) => m.folder === folder)
      .map((m) => ({ id: m.id, uid: m.uid, seen: m.seen, flagged: m.flagged }));
  }
  async putFolder(item: FolderItem) {
    this.calls.push(`putFolder(${item.name})`);
    this.folders.set(item.name, { ...item });
  }
  async listFolders() {
    return [...this.folders.values()];
  }

  asStore(): MailStore {
    return this as unknown as MailStore;
  }
}
