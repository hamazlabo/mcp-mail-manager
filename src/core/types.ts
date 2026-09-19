/**
 * 共有の型と DynamoDB キー設計（design.md 4 章・5 章）。
 * core / mcp / sync / scheduled-send のすべてがここを参照する。振る舞いは持たない。
 */

/** Secrets Manager `mail-mcp/<stage>/mail` を既定値補完・MX 導出した後の接続設定（design.md 5 章）。 */
export interface MailConfig {
  /** カスタムドメイン。MX 導出・ログイン名・From に使う */
  domain: string;
  /** メールアドレスのローカル部 */
  user: string;
  /** `<user>@<domain>`。IMAP / SMTP のログイン名であり From アドレス（固定） */
  address: string;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** true = SMTPS(465)、false = STARTTLS(587) */
  smtpSecure: boolean;
  fromName?: string;
  sentFolder: string;
  trashFolder: string;
}

export interface AttachmentMeta {
  filename: string;
  contentType: string;
  size: number;
}

/** mime.ts の出力（REQ-011）。添付の本体は含まない。 */
export interface ParsedMessage {
  headers: {
    from: string;
    to: string[];
    cc: string[];
    /** ISO 8601。Date ヘッダが無ければ undefined */
    date?: string;
    subject: string;
    messageId?: string;
    inReplyTo?: string;
    references: string[];
  };
  /** text/plain。無ければ text/html をテキスト化したもの */
  text: string;
  attachments: AttachmentMeta[];
}

export type SpecialUse = 'sent' | 'trash';

/** DynamoDB Message アイテム。PK=MSG#<id> SK=META（design.md 4 章）。 */
export interface MessageItem {
  /** ids.ts が導出する 32 桁 hex */
  id: string;
  messageId?: string;
  folder: string;
  uid: number;
  uidValidity: number;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  /** ISO 8601 (UTC)。INTERNALDATE 由来 */
  receivedAt: string;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  attachments: AttachmentMeta[];
  /** 生メッセージのバイト数 */
  size: number;
  s3Key: string;
  /** 大文字小文字を無視した部分一致用（REQ-010）。store.ts が保存時に小文字化して生成する */
  subjectLower: string;
  fromLower: string;
  /** to を ", " で連結して小文字化 */
  toLower: string;
}

/** 検索結果 1 件（REQ-010: 本文を含めない）。 */
export type MessageSummary = Pick<
  MessageItem,
  'id' | 'folder' | 'subject' | 'from' | 'to' | 'receivedAt' | 'seen' | 'flagged' | 'hasAttachments'
>;

export interface FolderItem {
  name: string;
  delimiter: string;
  specialUse?: SpecialUse;
  total: number;
  unread: number;
  lastSyncAt: string;
}

export interface SyncStateItem {
  folder: string;
  uidValidity: number;
  lastUid: number;
  initialDone: boolean;
  updatedAt: string;
}

export type ScheduledStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';

export interface ScheduledItem {
  scheduleId: string;
  status: ScheduledStatus;
  /** ISO 8601 (UTC) */
  sendAt: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** 予約時に採番。SMTP 送信と Sent APPEND で同じ値を使う */
  messageId: string;
  /** EventBridge Scheduler のスケジュール名 */
  scheduleName: string;
  attempts: number;
  error?: string;
  createdAt: string;
  /** 終端状態になってから 90 日（epoch 秒）。scheduled.ts が付与 */
  ttl?: number;
}

export const GSI1 = 'GSI1';
export const GSI2 = 'GSI2';

/** DynamoDB のキー組立。ここ以外で `MSG#` 等の文字列を組み立てない。 */
export const keys = {
  message: (id: string) => ({ PK: `MSG#${id}`, SK: 'META' }),
  folder: (name: string) => ({ PK: `FOLDER#${name}`, SK: 'META' }),
  syncState: (folder: string) => ({ PK: `SYNC#${folder}`, SK: 'STATE' }),
  scheduled: (scheduleId: string) => ({ PK: `SCHED#${scheduleId}`, SK: 'META' }),
  /** GSI1: フォルダ内 UID 集合（同期の照合） */
  gsi1Message: (folder: string, uid: number) => ({
    GSI1PK: `FOLDER#${folder}`,
    GSI1SK: `UID#${String(uid).padStart(10, '0')}`,
  }),
  /** GSI2: 全フォルダの受信日時順 */
  gsi2Message: (receivedAt: string, id: string) => ({ GSI2PK: 'ALL', GSI2SK: `${receivedAt}#${id}` }),
  /** GSI2: フォルダ一覧（Scan を避けるため） */
  gsi2Folder: (name: string) => ({ GSI2PK: 'FOLDER', GSI2SK: name }),
  /** GSI2: 予約一覧（送信予定日時順） */
  gsi2Scheduled: (sendAt: string, scheduleId: string) => ({ GSI2PK: 'SCHED', GSI2SK: `${sendAt}#${scheduleId}` }),
} as const;

/** S3 の生メッセージキー */
export const rawKey = (id: string) => `raw/${id}.eml`;
