/**
 * ImapSession: imapflow の薄いラッパ（design.md 3.4）。
 * - 移動は CAPABILITY に MOVE があれば UID MOVE、無ければ UID COPY + \Deleted（さくら）。
 * - EXPUNGE は決して発行しない（REQ-032。静的テストで検証）。
 * - 特殊フォルダは SPECIAL-USE 属性を優先し、無ければ設定値（sentFolder / trashFolder）。
 */
import { ImapFlow } from 'imapflow';
import type { CopyResponseObject, FetchMessageObject, ListResponse, MailboxObject, SearchObject } from 'imapflow';
import type { MailConfig, SpecialUse } from './types';

export interface ImapFolder {
  name: string;
  delimiter: string;
  specialUse?: SpecialUse;
}

export interface ImapMailbox {
  uidValidity: number;
  uidNext: number;
  exists: number;
}

export interface ImapFlags {
  uid: number;
  seen: boolean;
  flagged: boolean;
  deleted: boolean;
}

export interface ImapMessage extends ImapFlags {
  internalDate: Date;
  /** RFC 5322 生メッセージ（BODY.PEEK[]） */
  raw: Buffer;
}

export interface ImapSession {
  /** LIST 全フォルダ。SPECIAL-USE 属性（\Sent / \Trash）があれば specialUse を付ける */
  listFolders(): Promise<ImapFolder[]>;
  /** Sent / Trash の解決。SPECIAL-USE 優先、無ければ MailConfig の sentFolder / trashFolder */
  specialFolders(): Promise<Record<SpecialUse, string>>;
  /** SELECT（読み書き）。閉じるときも expunge しない */
  select(folder: string): Promise<ImapMailbox>;
  /** UID SEARCH。since は INTERNALDATE 基準（初回同期の 90 日）、uidFrom は `uidFrom:*`（差分同期） */
  searchUids(folder: string, criteria: { since?: Date; uidFrom?: number }): Promise<number[]>;
  /** UID FETCH (BODY.PEEK[] FLAGS INTERNALDATE)。\Seen を付けない。呼出側が 50 通ずつに分ける */
  fetchMessages(folder: string, uids: number[]): Promise<ImapMessage[]>;
  /** UID FETCH uidFrom:* (FLAGS)。照合フェーズ用 */
  fetchFlags(folder: string, uidFrom: number): Promise<ImapFlags[]>;
  /** \Seen / \Flagged の付与・解除（undefined のフラグは触らない） */
  setFlags(folder: string, uid: number, flags: { seen?: boolean; flagged?: boolean }): Promise<void>;
  /** 移動。新しいフォルダと UID（COPYUID / MOVE 応答）を返す。移動先が無ければ例外。EXPUNGE しない */
  move(folder: string, uid: number, destination: string): Promise<{ folder: string; uid: number }>;
  /** APPEND（送信済みの Sent 保存用） */
  append(folder: string, raw: Buffer, flags?: string[], date?: Date): Promise<{ uid?: number }>;
  /** Sent フォルダに指定 Message-ID のメッセージが存在するか（予約送信の結果不明時の確認） */
  searchSent(messageId: string): Promise<boolean>;
  /** LOGOUT。expunge しない */
  close(): Promise<void>;
}

export type ImapSessionFactory = (config: MailConfig) => Promise<ImapSession>;

// ---------------------------------------------------------------------------
// imapflow 実装
// ---------------------------------------------------------------------------

/**
 * ラッパが使ってよい imapflow の API だけに絞る。
 * CLOSE / EXPUNGE / messageDelete はここに含めない（型レベルで呼べない）。
 */
type ImapClient = Pick<
  ImapFlow,
  | 'capabilities'
  | 'connect'
  | 'logout'
  | 'list'
  | 'mailboxOpen'
  | 'search'
  | 'fetchAll'
  | 'messageFlagsAdd'
  | 'messageFlagsRemove'
  | 'messageMove'
  | 'messageCopy'
  | 'append'
>;

const SPECIAL_USE: Record<string, SpecialUse> = { '\\Sent': 'sent', '\\Trash': 'trash' };

function flagsOf(uid: number, flags?: Set<string>): ImapFlags {
  return {
    uid,
    seen: flags?.has('\\Seen') ?? false,
    flagged: flags?.has('\\Flagged') ?? false,
    deleted: flags?.has('\\Deleted') ?? false,
  };
}

export class ImapFlowSession implements ImapSession {
  private current?: string;
  private folders?: ImapFolder[];

  constructor(
    private readonly client: ImapClient,
    private readonly config: MailConfig,
  ) {}

  /** 既に開いているフォルダは再 SELECT しない（force で強制） */
  private async open(folder: string, force = false): Promise<MailboxObject | undefined> {
    if (!force && this.current === folder) return undefined;
    const box = await this.client.mailboxOpen(folder);
    this.current = folder;
    return box;
  }

  async listFolders(): Promise<ImapFolder[]> {
    if (!this.folders) {
      const listed = await this.client.list();
      this.folders = listed.map((f: ListResponse) => ({
        name: f.path,
        delimiter: f.delimiter,
        // imapflow はフォルダ名からも特殊用途を推定する（specialUseSource: 'name'）。サーバが属性で返したものだけ採用する
        specialUse: f.specialUse && f.specialUseSource !== 'name' ? SPECIAL_USE[f.specialUse] : undefined,
      }));
    }
    return this.folders;
  }

  async specialFolders(): Promise<Record<SpecialUse, string>> {
    const folders = await this.listFolders();
    const find = (use: SpecialUse) => folders.find((f) => f.specialUse === use)?.name;
    return {
      sent: find('sent') ?? this.config.sentFolder,
      trash: find('trash') ?? this.config.trashFolder,
    };
  }

  async select(folder: string): Promise<ImapMailbox> {
    const box = (await this.open(folder, true)) as MailboxObject;
    return { uidValidity: Number(box.uidValidity), uidNext: box.uidNext, exists: box.exists };
  }

  async searchUids(folder: string, criteria: { since?: Date; uidFrom?: number }): Promise<number[]> {
    await this.open(folder);
    const query: SearchObject = {};
    if (criteria.since) query.since = criteria.since;
    if (criteria.uidFrom !== undefined) query.uid = `${criteria.uidFrom}:*`;
    const result = await this.client.search(query, { uid: true });
    const uids = Array.isArray(result) ? result : [];
    // `n:*` は n が最大 UID を超えると最大 UID の 1 通を返す（RFC 3501）。差分同期では除外する
    return criteria.uidFrom === undefined ? uids : uids.filter((uid) => uid >= criteria.uidFrom!);
  }

  async fetchMessages(folder: string, uids: number[]): Promise<ImapMessage[]> {
    if (uids.length === 0) return [];
    await this.open(folder);
    // source は BODY.PEEK[] で取得されるため \Seen は付かない
    const messages = await this.client.fetchAll(uids, { uid: true, flags: true, internalDate: true, source: true }, { uid: true });
    return messages.map((m: FetchMessageObject) => ({
      ...flagsOf(m.uid, m.flags),
      internalDate: new Date(m.internalDate ?? 0),
      raw: m.source ?? Buffer.alloc(0),
    }));
  }

  async fetchFlags(folder: string, uidFrom: number): Promise<ImapFlags[]> {
    await this.open(folder);
    const messages = await this.client.fetchAll(`${uidFrom}:*`, { uid: true, flags: true }, { uid: true });
    return messages.filter((m) => m.uid >= uidFrom).map((m) => flagsOf(m.uid, m.flags));
  }

  async setFlags(folder: string, uid: number, flags: { seen?: boolean; flagged?: boolean }): Promise<void> {
    await this.open(folder);
    const add: string[] = [];
    const remove: string[] = [];
    if (flags.seen !== undefined) (flags.seen ? add : remove).push('\\Seen');
    if (flags.flagged !== undefined) (flags.flagged ? add : remove).push('\\Flagged');
    if (add.length) await this.client.messageFlagsAdd([uid], add, { uid: true });
    if (remove.length) await this.client.messageFlagsRemove([uid], remove, { uid: true });
  }

  async move(folder: string, uid: number, destination: string): Promise<{ folder: string; uid: number }> {
    await this.open(folder);
    if (this.client.capabilities.has('MOVE')) {
      const res = await this.client.messageMove([uid], destination, { uid: true });
      if (!res) await this.assertFolderExists(destination);
      return { folder: destination, uid: newUid(res, uid, folder) };
    }
    // MOVE 非対応（さくら）: COPY + \Deleted。imapflow の messageMove は非対応時に EXPUNGE まで行うので使わない
    const res = await this.client.messageCopy([uid], destination, { uid: true });
    // imapflow は移動先が無い NO [TRYCREATE] を投げずに false を返すことがある。原因を区別して報告する
    if (!res) await this.assertFolderExists(destination);
    const copied = newUid(res, uid, folder);
    await this.client.messageFlagsAdd([uid], ['\\Deleted'], { uid: true });
    return { folder: destination, uid: copied };
  }

  private async assertFolderExists(destination: string): Promise<void> {
    const boxes = await this.client.list();
    if (!boxes.some((b) => b.path === destination)) throw new Error(`folder not found: ${destination}`);
  }

  async append(folder: string, raw: Buffer, flags?: string[], date?: Date): Promise<{ uid?: number }> {
    const res = await this.client.append(folder, raw, flags, date);
    return res ? { uid: res.uid } : {};
  }

  async searchSent(messageId: string): Promise<boolean> {
    const { sent } = await this.specialFolders();
    await this.open(sent);
    const result = await this.client.search({ header: { 'message-id': messageId } }, { uid: true });
    return Array.isArray(result) && result.length > 0;
  }

  async close(): Promise<void> {
    await this.client.logout();
  }
}

/** COPYUID / MOVE 応答から移動先の UID を得る（UIDPLUS 前提。さくらは対応） */
function newUid(res: CopyResponseObject | false, uid: number, folder: string): number {
  if (!res) throw new Error(`message uid ${uid} not found in ${folder}`);
  const mapped = res.uidMap?.get(uid);
  if (mapped === undefined) throw new Error(`server did not return COPYUID for uid ${uid} (${folder} -> ${res.destination})`);
  return mapped;
}

export const openImapSession: ImapSessionFactory = async (config) => {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: true,
    // さくらはローカル部だけでは Login failed。ユーザ名はメールアドレス全体
    auth: { user: config.address, pass: config.password },
    logger: false,
  });
  await client.connect();
  return new ImapFlowSession(client, config);
};
