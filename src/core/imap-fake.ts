/**
 * テスト用のメモリ上 ImapSession。IMAP サーバ無しで sync / tools / scheduled-send を検証する。
 * move は COPY + \Deleted 相当（移動元に deleted のまま残す）。
 */
import type { ImapFlags, ImapFolder, ImapMailbox, ImapMessage, ImapSession } from './imap';
import type { MailConfig, SpecialUse } from './types';

export interface FakeMessage {
  raw: Buffer;
  flags: Set<string>;
  internalDate: Date;
}

export interface FakeFolder {
  uidValidity: number;
  nextUid: number;
  messages: Map<number, FakeMessage>;
}

export class FakeImapSession implements ImapSession {
  /** 呼ばれたメソッドと引数の簡易記録（例: `move(INBOX,7,INBOX.Trash)`） */
  readonly calls: string[] = [];
  readonly folders = new Map<string, FakeFolder>();
  private readonly config: MailConfig;
  private readonly specialUse: boolean;

  constructor(opts: { config: MailConfig; folders?: string[]; specialUse?: boolean }) {
    this.config = opts.config;
    this.specialUse = opts.specialUse ?? false;
    for (const name of opts.folders ?? ['INBOX', opts.config.sentFolder, opts.config.trashFolder]) this.addFolder(name);
  }

  addFolder(name: string, uidValidity = 1000 + this.folders.size): FakeFolder {
    const folder: FakeFolder = { uidValidity, nextUid: 1, messages: new Map() };
    this.folders.set(name, folder);
    return folder;
  }

  /** メッセージを追加して UID を返す */
  addMessage(folderName: string, raw: Buffer, opts: { seen?: boolean; flagged?: boolean; internalDate?: Date } = {}): number {
    const folder = this.folder(folderName);
    const flags = new Set<string>();
    if (opts.seen) flags.add('\\Seen');
    if (opts.flagged) flags.add('\\Flagged');
    const uid = folder.nextUid++;
    folder.messages.set(uid, { raw, flags, internalDate: opts.internalDate ?? new Date() });
    return uid;
  }

  private folder(name: string): FakeFolder {
    const folder = this.folders.get(name);
    if (!folder) throw new Error(`NO [TRYCREATE] mailbox does not exist: ${name}`);
    return folder;
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push(`${method}(${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(',')})`);
  }

  async listFolders(): Promise<ImapFolder[]> {
    this.record('listFolders');
    return [...this.folders.keys()].map((name) => {
      const use: SpecialUse | undefined =
        name === this.config.sentFolder ? 'sent' : name === this.config.trashFolder ? 'trash' : undefined;
      return { name, delimiter: '.', specialUse: this.specialUse ? use : undefined };
    });
  }

  async specialFolders(): Promise<Record<SpecialUse, string>> {
    this.record('specialFolders');
    return { sent: this.config.sentFolder, trash: this.config.trashFolder };
  }

  async select(name: string): Promise<ImapMailbox> {
    this.record('select', name);
    const folder = this.folder(name);
    return { uidValidity: folder.uidValidity, uidNext: folder.nextUid, exists: folder.messages.size };
  }

  async searchUids(name: string, criteria: { since?: Date; uidFrom?: number }): Promise<number[]> {
    this.record('searchUids', name, criteria);
    return [...this.folder(name).messages.entries()]
      .filter(([uid, m]) => (criteria.uidFrom === undefined || uid >= criteria.uidFrom) && (!criteria.since || m.internalDate >= criteria.since))
      .map(([uid]) => uid)
      .sort((a, b) => a - b);
  }

  async fetchMessages(name: string, uids: number[]): Promise<ImapMessage[]> {
    this.record('fetchMessages', name, uids);
    const folder = this.folder(name);
    return uids
      .filter((uid) => folder.messages.has(uid))
      .map((uid) => {
        const m = folder.messages.get(uid)!;
        return { ...flagsOf(uid, m.flags), internalDate: m.internalDate, raw: m.raw };
      });
  }

  async fetchFlags(name: string, uidFrom: number): Promise<ImapFlags[]> {
    this.record('fetchFlags', name, uidFrom);
    return [...this.folder(name).messages.entries()]
      .filter(([uid]) => uid >= uidFrom)
      .sort(([a], [b]) => a - b)
      .map(([uid, m]) => flagsOf(uid, m.flags));
  }

  async setFlags(name: string, uid: number, flags: { seen?: boolean; flagged?: boolean }): Promise<void> {
    this.record('setFlags', name, uid, flags);
    const m = this.message(name, uid);
    if (flags.seen !== undefined) toggle(m.flags, '\\Seen', flags.seen);
    if (flags.flagged !== undefined) toggle(m.flags, '\\Flagged', flags.flagged);
  }

  async move(name: string, uid: number, destination: string): Promise<{ folder: string; uid: number }> {
    this.record('move', name, uid, destination);
    const m = this.message(name, uid);
    const dest = this.folder(destination);
    const newUid = dest.nextUid++;
    dest.messages.set(newUid, { raw: m.raw, flags: new Set([...m.flags].filter((f) => f !== '\\Deleted')), internalDate: m.internalDate });
    m.flags.add('\\Deleted');
    return { folder: destination, uid: newUid };
  }

  async append(name: string, raw: Buffer, flags: string[] = [], date = new Date()): Promise<{ uid?: number }> {
    this.record('append', name, flags);
    const folder = this.folder(name);
    const uid = folder.nextUid++;
    folder.messages.set(uid, { raw, flags: new Set(flags), internalDate: date });
    return { uid };
  }

  async searchSent(messageId: string): Promise<boolean> {
    this.record('searchSent', messageId);
    const wanted = messageId.trim();
    for (const m of this.folder(this.config.sentFolder).messages.values()) {
      const found = /^message-id:\s*(.+)$/im.exec(m.raw.toString('utf8'))?.[1].trim();
      if (found === wanted) return true;
    }
    return false;
  }

  async close(): Promise<void> {
    this.record('close');
  }

  private message(name: string, uid: number): FakeMessage {
    const m = this.folder(name).messages.get(uid);
    if (!m) throw new Error(`message uid ${uid} not found in ${name}`);
    return m;
  }
}

function flagsOf(uid: number, flags: Set<string>): ImapFlags {
  return { uid, seen: flags.has('\\Seen'), flagged: flags.has('\\Flagged'), deleted: flags.has('\\Deleted') };
}

function toggle(flags: Set<string>, flag: string, on: boolean): void {
  if (on) flags.add(flag);
  else flags.delete(flag);
}
