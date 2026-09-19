/**
 * MailStore: DynamoDB（単一テーブル）+ S3（生メッセージ）へのアクセス（design.md 4 章）。
 * キーの組立は types.ts の keys / rawKey に集約し、返却値からは内部キー属性を取り除く。
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  GSI1,
  GSI2,
  keys,
  rawKey,
  type FolderItem,
  type MessageItem,
  type ScheduledItem,
  type ScheduledStatus,
  type SyncStateItem,
} from './types';

export interface MailStoreOptions {
  tableName: string;
  bucketName: string;
  ddb?: DynamoDBDocumentClient;
  s3?: S3Client;
}

export interface FolderUid {
  id: string;
  uid: number;
  seen: boolean;
  flagged: boolean;
}

type Key = Record<string, string>;
type Item = Record<string, unknown>;

const KEY_ATTRIBUTES = ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK'];
const YEAR_SECONDS = 365 * 86400;

/** 内部キー属性（PK/SK/GSI*）を取り除く。 */
export function stripKeys<T>(item: Item): T {
  const copy: Item = { ...item };
  for (const attr of KEY_ATTRIBUTES) delete copy[attr];
  return copy as T;
}

export class MailStore {
  readonly ddb: DynamoDBDocumentClient;
  readonly s3: S3Client;
  readonly tableName: string;
  readonly bucketName: string;

  constructor(options: MailStoreOptions) {
    this.tableName = options.tableName;
    this.bucketName = options.bucketName;
    this.ddb =
      options.ddb ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    this.s3 = options.s3 ?? new S3Client({});
  }

  // ---- Message ----

  /** 同じ id は上書きされる（フォルダ移動の検出・冪等な再取込）。ttl は受信日時 + 1 年（NFR-002）。 */
  async putMessage(item: MessageItem): Promise<void> {
    await this.put({
      ...item,
      ...keys.message(item.id),
      ...keys.gsi1Message(item.folder, item.uid),
      ...keys.gsi2Message(item.receivedAt, item.id),
      subjectLower: item.subject.toLowerCase(),
      fromLower: item.from.toLowerCase(),
      toLower: item.to.join(', ').toLowerCase(),
      ttl: Math.floor(Date.parse(item.receivedAt) / 1000) + YEAR_SECONDS,
    });
  }

  getMessage(id: string): Promise<MessageItem | undefined> {
    return this.get<MessageItem>(keys.message(id));
  }

  deleteMessage(id: string): Promise<void> {
    return this.delete(keys.message(id));
  }

  /** 指定されたフラグ属性だけを更新する。 */
  async updateFlags(id: string, flags: { seen?: boolean; flagged?: boolean }): Promise<void> {
    const given = Object.entries(flags).filter(([, v]) => v !== undefined);
    if (given.length === 0) return;
    await this.update(keys.message(id), Object.fromEntries(given));
  }

  /** 移動後のフォルダ / UID を反映する（GSI1 キーも更新）。 */
  /** search.ts が組み立てた GSI2 Query をそのまま実行する。 */
  async queryMessages(
    query: QueryCommandInput,
  ): Promise<{ items: MessageItem[]; lastEvaluatedKey?: Record<string, unknown> }> {
    const res = await this.ddb.send(new QueryCommand(query));
    return { items: (res.Items ?? []).map((i) => stripKeys<MessageItem>(i)), lastEvaluatedKey: res.LastEvaluatedKey };
  }

  /** 同期の照合用: フォルダ内の既知 UID 集合（GSI1、射影付き）。 */
  async listFolderUids(folder: string): Promise<FolderUid[]> {
    const items = await this.queryAll({
      TableName: this.tableName,
      IndexName: GSI1,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': keys.gsi1Message(folder, 0).GSI1PK },
      ProjectionExpression: '#id, #uid, #seen, #flagged',
      ExpressionAttributeNames: { '#id': 'id', '#uid': 'uid', '#seen': 'seen', '#flagged': 'flagged' },
    });
    return items as unknown as FolderUid[];
  }

  // ---- Folder ----

  async putFolder(item: FolderItem): Promise<void> {
    await this.put({ ...item, ...keys.folder(item.name), ...keys.gsi2Folder(item.name) });
  }

  async listFolders(): Promise<FolderItem[]> {
    const items = await this.queryAll({
      TableName: this.tableName,
      IndexName: GSI2,
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': keys.gsi2Folder('').GSI2PK },
    });
    return items.map((i) => stripKeys<FolderItem>(i));
  }

  // ---- SyncState ----

  getSyncState(folder: string): Promise<SyncStateItem | undefined> {
    return this.get<SyncStateItem>(keys.syncState(folder));
  }

  async putSyncState(item: SyncStateItem): Promise<void> {
    await this.put({ ...item, ...keys.syncState(item.folder) });
  }

  deleteSyncState(folder: string): Promise<void> {
    return this.delete(keys.syncState(folder));
  }

  // ---- Scheduled ----

  async putScheduled(item: ScheduledItem): Promise<void> {
    await this.put({ ...item, ...keys.scheduled(item.scheduleId), ...keys.gsi2Scheduled(item.sendAt, item.scheduleId) });
  }

  getScheduled(scheduleId: string): Promise<ScheduledItem | undefined> {
    return this.get<ScheduledItem>(keys.scheduled(scheduleId));
  }

  deleteScheduled(scheduleId: string): Promise<void> {
    return this.delete(keys.scheduled(scheduleId));
  }

  /** 送信予定日時順。status 指定時はその状態のみ。 */
  async listScheduled(status?: ScheduledStatus): Promise<ScheduledItem[]> {
    const items = await this.queryAll({
      TableName: this.tableName,
      IndexName: GSI2,
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': keys.gsi2Scheduled('', '').GSI2PK, ...(status && { ':status': status }) },
      ...(status && { FilterExpression: '#status = :status', ExpressionAttributeNames: { '#status': 'status' } }),
    });
    return items.map((i) => stripKeys<ScheduledItem>(i));
  }

  // ---- S3 raw messages ----

  async putRaw(id: string, raw: Buffer): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucketName, Key: rawKey(id), Body: raw, ContentType: 'message/rfc822' }),
    );
  }

  /** 存在しなければ undefined。 */
  async getRaw(id: string): Promise<Buffer | undefined> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucketName, Key: rawKey(id) }));
      return Buffer.from(await res.Body!.transformToByteArray());
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return undefined;
      throw err;
    }
  }

  /** レコードの s3Key で削除する。ツールで移動したレコードは元 id のキーを参照し続けるため、id からは組み立てない */
  async deleteRawKey(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));
  }

  // ---- 内部ヘルパ ----

  private async put(item: Item): Promise<void> {
    await this.ddb.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  private async get<T>(key: Key): Promise<T | undefined> {
    const res = await this.ddb.send(new GetCommand({ TableName: this.tableName, Key: key }));
    return res.Item ? stripKeys<T>(res.Item) : undefined;
  }

  private async delete(key: Key): Promise<void> {
    await this.ddb.send(new DeleteCommand({ TableName: this.tableName, Key: key }));
  }

  /** SET 更新。属性名は予約語衝突を避けるため全て # 別名にする。 */
  private async update(key: Key, attributes: Item): Promise<void> {
    const entries = Object.entries(attributes);
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: key,
        UpdateExpression: `SET ${entries.map(([name]) => `#${name} = :${name}`).join(', ')}`,
        ExpressionAttributeNames: Object.fromEntries(entries.map(([name]) => [`#${name}`, name])),
        ExpressionAttributeValues: Object.fromEntries(entries.map(([name, value]) => [`:${name}`, value])),
      }),
    );
  }

  private async queryAll(input: QueryCommandInput): Promise<Item[]> {
    const items: Item[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.ddb.send(new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }));
      items.push(...(res.Items ?? []));
      exclusiveStartKey = res.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }
}
