import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { MailStore } from '../../../src/core/store';
import type { FolderItem, MessageItem, ScheduledItem, SyncStateItem } from '../../../src/core/types';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

const message: MessageItem = {
  id: 'a'.repeat(32),
  messageId: '<abc@example.net>',
  folder: 'INBOX',
  uid: 42,
  uidValidity: 1700000000,
  subject: 'Hello World',
  from: 'Alice <Alice@Example.net>',
  to: ['Bob@example.net', 'carol@example.org'],
  cc: [],
  receivedAt: '2026-09-01T00:00:00.000Z',
  seen: false,
  flagged: false,
  hasAttachments: true,
  attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', size: 1234 }],
  size: 5678,
  s3Key: `raw/${'a'.repeat(32)}.eml`,
  subjectLower: '',
  fromLower: '',
  toLower: '',
};

function store() {
  return new MailStore({
    tableName: 'MailTable-test',
    bucketName: 'bucket-test',
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    s3: new S3Client({}),
  });
}

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
});

describe('MailStore messages', () => {
  it('putMessage builds PK/SK, GSI1, GSI2, lower-cased fields and ttl', async () => {
    ddbMock.on(PutCommand).resolves({});
    await store().putMessage(message);

    const input = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(input.TableName).toBe('MailTable-test');
    expect(input.Item).toMatchObject({
      PK: `MSG#${message.id}`,
      SK: 'META',
      GSI1PK: 'FOLDER#INBOX',
      GSI1SK: 'UID#0000000042',
      GSI2PK: 'ALL',
      GSI2SK: `2026-09-01T00:00:00.000Z#${message.id}`,
      subjectLower: 'hello world',
      fromLower: 'alice <alice@example.net>',
      toLower: 'bob@example.net, carol@example.org',
      ttl: Math.floor(Date.parse('2026-09-01T00:00:00.000Z') / 1000) + 365 * 86400,
    });
  });

  it('getMessage strips key attributes and returns undefined when missing', async () => {
    ddbMock
      .on(GetCommand, { Key: { PK: `MSG#${message.id}`, SK: 'META' } })
      .resolves({ Item: { ...message, PK: 'x', SK: 'META', GSI1PK: 'f', GSI1SK: 'u', GSI2PK: 'ALL', GSI2SK: 'k' } });
    const got = await store().getMessage(message.id);
    expect(got).toEqual(message);
    expect(got).not.toHaveProperty('PK');
    expect(got).not.toHaveProperty('GSI2SK');

    ddbMock.on(GetCommand).resolves({});
    expect(await store().getMessage('missing')).toBeUndefined();
  });

  it('queryMessages runs the given GSI2 query descending and returns items and the continuation key', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ ...message, PK: 'p', SK: 'META', GSI2PK: 'ALL', GSI2SK: 'k' }],
      LastEvaluatedKey: { PK: 'p', SK: 'META', GSI2PK: 'ALL', GSI2SK: 'k' },
    });
    const query = {
      TableName: 'MailTable-test',
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': 'ALL', ':from': '2026-06-01', ':to': '2026-09-19￿' },
      ScanIndexForward: false,
      Limit: 20,
    };
    const result = await store().queryMessages(query);

    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input).toEqual(query);
    expect(result.items).toEqual([message]);
    expect(result.lastEvaluatedKey).toEqual({ PK: 'p', SK: 'META', GSI2PK: 'ALL', GSI2SK: 'k' });
  });

  it('listFolderUids queries GSI1 with a projection and follows pagination', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ id: 'id1', uid: 1, seen: true, flagged: false }], LastEvaluatedKey: { PK: 'p' } })
      .resolvesOnce({ Items: [{ id: 'id2', uid: 2, seen: false, flagged: true }] });

    const uids = await store().listFolderUids('INBOX');

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    const first = calls[0].args[0].input;
    expect(first.IndexName).toBe('GSI1');
    expect(first.ExpressionAttributeValues).toMatchObject({ ':pk': 'FOLDER#INBOX' });
    expect(first.ProjectionExpression).toBeDefined();
    expect(calls[1].args[0].input.ExclusiveStartKey).toEqual({ PK: 'p' });
    expect(uids).toEqual([
      { id: 'id1', uid: 1, seen: true, flagged: false },
      { id: 'id2', uid: 2, seen: false, flagged: true },
    ]);
  });

  it('updateFlags issues an UpdateItem with only the given flags', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await store().updateFlags(message.id, { seen: true });

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual({ PK: `MSG#${message.id}`, SK: 'META' });
    expect(input.UpdateExpression).toMatch(/seen/);
    expect(input.UpdateExpression).not.toMatch(/flagged/);
    expect(Object.values(input.ExpressionAttributeValues ?? {})).toEqual([true]);
  });

  it('deleteMessage deletes by key', async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await store().deleteMessage(message.id);
    expect(ddbMock.commandCalls(DeleteCommand)[0].args[0].input.Key).toEqual({ PK: `MSG#${message.id}`, SK: 'META' });
  });
});

describe('MailStore folders and sync state', () => {
  it('putFolder adds GSI2 keys and listFolders queries GSI2 FOLDER', async () => {
    ddbMock.on(PutCommand).resolves({});
    const folder: FolderItem = { name: 'INBOX.Sent', delimiter: '.', specialUse: 'sent', total: 3, unread: 0, lastSyncAt: '2026-09-19T00:00:00.000Z' };
    await store().putFolder(folder);
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject({
      PK: 'FOLDER#INBOX.Sent',
      SK: 'META',
      GSI2PK: 'FOLDER',
      GSI2SK: 'INBOX.Sent',
    });

    ddbMock.on(QueryCommand).resolves({ Items: [{ ...folder, PK: 'FOLDER#INBOX.Sent', SK: 'META', GSI2PK: 'FOLDER', GSI2SK: 'INBOX.Sent' }] });
    const folders = await store().listFolders();
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      IndexName: 'GSI2',
      ExpressionAttributeValues: { ':pk': 'FOLDER' },
    });
    expect(folders).toEqual([folder]);
  });

  it('sync state round-trips by SYNC#<folder>/STATE', async () => {
    const state: SyncStateItem = { folder: 'INBOX', uidValidity: 1, lastUid: 10, initialDone: true, updatedAt: '2026-09-19T00:00:00.000Z' };
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: { ...state, PK: 'SYNC#INBOX', SK: 'STATE' } });
    ddbMock.on(DeleteCommand).resolves({});

    await store().putSyncState(state);
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject({ PK: 'SYNC#INBOX', SK: 'STATE' });
    expect(await store().getSyncState('INBOX')).toEqual(state);
    await store().deleteSyncState('INBOX');
    expect(ddbMock.commandCalls(DeleteCommand)[0].args[0].input.Key).toEqual({ PK: 'SYNC#INBOX', SK: 'STATE' });
  });
});

describe('MailStore scheduled', () => {
  const scheduled: ScheduledItem = {
    scheduleId: 'sch-1',
    status: 'pending',
    sendAt: '2026-10-01T09:00:00.000Z',
    to: ['bob@example.net'],
    cc: [],
    bcc: [],
    subject: 'later',
    body: 'hi',
    messageId: '<uuid@example.net>',
    scheduleName: 'mail-mcp-sch-1',
    attempts: 0,
    createdAt: '2026-09-19T00:00:00.000Z',
  };

  it('putScheduled adds SCHED keys and GSI2, listScheduled queries GSI2 SCHED with optional status filter', async () => {
    ddbMock.on(PutCommand).resolves({});
    await store().putScheduled(scheduled);
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject({
      PK: 'SCHED#sch-1',
      SK: 'META',
      GSI2PK: 'SCHED',
      GSI2SK: '2026-10-01T09:00:00.000Z#sch-1',
    });

    ddbMock.on(QueryCommand).resolves({ Items: [{ ...scheduled, PK: 'SCHED#sch-1', SK: 'META', GSI2PK: 'SCHED', GSI2SK: 'x' }] });
    expect(await store().listScheduled()).toEqual([scheduled]);
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.FilterExpression).toBeUndefined();

    await store().listScheduled('pending');
    const filtered = ddbMock.commandCalls(QueryCommand)[1].args[0].input;
    expect(filtered.FilterExpression).toBeDefined();
    expect(Object.values(filtered.ExpressionAttributeValues ?? {})).toContain('pending');
  });

  it('getScheduled / deleteScheduled use SCHED#<id>', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...scheduled, PK: 'SCHED#sch-1', SK: 'META' } });
    ddbMock.on(DeleteCommand).resolves({});
    expect(await store().getScheduled('sch-1')).toEqual(scheduled);
    await store().deleteScheduled('sch-1');
    expect(ddbMock.commandCalls(DeleteCommand)[0].args[0].input.Key).toEqual({ PK: 'SCHED#sch-1', SK: 'META' });
  });
});

describe('MailStore raw messages (S3)', () => {
  it('putRaw PUTs raw/<id>.eml as message/rfc822', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    await store().putRaw(message.id, Buffer.from('From: a\r\n\r\nbody'));

    const input = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(input).toMatchObject({ Bucket: 'bucket-test', Key: `raw/${message.id}.eml`, ContentType: 'message/rfc822' });
    expect(Buffer.from(input.Body as Buffer).toString()).toBe('From: a\r\n\r\nbody');
  });

  it('getRaw returns the body, or undefined for NoSuchKey', async () => {
    s3Mock.on(GetObjectCommand, { Key: `raw/${message.id}.eml` }).resolves({
      Body: { transformToByteArray: async () => new Uint8Array(Buffer.from('raw!')) } as never,
    });
    expect((await store().getRaw(message.id))?.toString()).toBe('raw!');

    s3Mock.on(GetObjectCommand, { Key: 'raw/missing.eml' }).rejects(new NoSuchKey({ $metadata: {}, message: 'NoSuchKey' }));
    expect(await store().getRaw('missing')).toBeUndefined();
  });

  it('deleteRawKey deletes the given S3 key (moved records point at another id\'s raw object)', async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    await store().deleteRawKey('raw/other-id.eml');
    expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input).toMatchObject({ Bucket: 'bucket-test', Key: 'raw/other-id.eml' });
  });
});
