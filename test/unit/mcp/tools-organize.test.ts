import { describe, expect, it } from 'vitest';
import { deriveId } from '../../../src/core/ids';
import { FakeImapSession } from '../../../src/core/imap-fake';
import type { MessageItem } from '../../../src/core/types';
import { registerMoveMessage } from '../../../src/mcp/tools/move_message';
import { registerSetFlagged } from '../../../src/mcp/tools/set_flagged';
import { registerSetRead } from '../../../src/mcp/tools/set_read';
import { registerTrashMessage } from '../../../src/mcp/tools/trash_message';
import { call, config, connect, json, makeCtx, text } from './helpers';

const RAW = Buffer.from('From: a@example.com\r\nSubject: x\r\nMessage-ID: <x@example.com>\r\n\r\nbody\r\n');

/** messageId に null を渡すと Message-ID 無しのメッセージになる */
function item(uid: number, messageId: string | null = '<x@example.com>'): MessageItem {
  return {
    id: 'id1',
    ...(messageId ? { messageId } : {}),
    folder: 'INBOX',
    uid,
    uidValidity: 1000,
    subject: 'x',
    from: 'a@example.com',
    to: ['me@example.net'],
    cc: [],
    receivedAt: '2026-09-10T00:00:00.000Z',
    seen: false,
    flagged: false,
    hasAttachments: false,
    attachments: [],
    size: 10,
    s3Key: 'raw/id1.eml',
    subjectLower: 'x',
    fromLower: 'a@example.com',
    toLower: 'me@example.net',
  };
}

/** フェイク IMAP + 記録付き store。updates には store が呼ばれた時点の IMAP 呼出数も残す */
function setup(uid: number, messageId?: string | null) {
  const imap = new FakeImapSession({ config, folders: ['INBOX', 'INBOX.Archive', config.sentFolder, config.trashFolder] });
  const realUid = imap.addMessage('INBOX', RAW);
  const updates: { method: string; args: unknown[]; imapCallsSoFar: number }[] = [];
  const record = (method: string) => async (...args: unknown[]) => {
    updates.push({ method, args, imapCallsSoFar: imap.calls.length });
  };
  const store = {
    getMessage: async (id: string) => (id === 'id1' ? item(uid === -1 ? realUid : uid, messageId) : undefined),
    updateFlags: record('updateFlags'),
    putMessage: record('putMessage'),
    deleteMessage: record('deleteMessage'),
  };
  const ctx = makeCtx({ store, imap });
  return { imap, updates, ctx, realUid };
}

const registerAll = (ctx: ReturnType<typeof makeCtx>) => (s: Parameters<typeof registerSetRead>[0]) => {
  registerSetRead(s, ctx);
  registerSetFlagged(s, ctx);
  registerMoveMessage(s, ctx);
  registerTrashMessage(s, ctx);
};

describe('organize tools: IMAP first, then DynamoDB (REQ-030〜033)', () => {
  it('set_read updates IMAP \\Seen and only then DynamoDB', async () => {
    const { imap, updates, ctx, realUid } = setup(-1);
    const client = await connect(registerAll(ctx));
    expect(json(await call(client, 'set_read', { id: 'id1', read: true }))).toEqual({ id: 'id1', seen: true });
    expect(imap.calls).toContain(`setFlags(INBOX,${realUid},{"seen":true})`);
    expect(updates).toEqual([{ method: 'updateFlags', args: ['id1', { seen: true }], imapCallsSoFar: expect.any(Number) }]);
    expect(updates[0].imapCallsSoFar).toBeGreaterThan(0); // IMAP が先
    expect(imap.calls.at(-1)).toBe('close()');
    expect((await imap.fetchFlags('INBOX', realUid))[0].seen).toBe(true);
  });

  it('set_flagged follows the same order', async () => {
    const { imap, updates, ctx, realUid } = setup(-1);
    const client = await connect(registerAll(ctx));
    expect(json(await call(client, 'set_flagged', { id: 'id1', flagged: true }))).toEqual({ id: 'id1', flagged: true });
    expect(imap.calls).toContain(`setFlags(INBOX,${realUid},{"flagged":true})`);
    expect(updates.map((u) => u.method)).toEqual(['updateFlags']);
  });

  it('does not touch DynamoDB and reports an error (without the password) when IMAP fails', async () => {
    const { updates, ctx } = setup(99); // UID 99 は IMAP に無い
    const client = await connect(registerAll(ctx));
    const result = await call(client, 'set_read', { id: 'id1', read: true });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('uid 99');
    expect(text(result)).not.toContain(config.password);
    expect(updates).toEqual([]);
  });

  it('fails for an unknown message id', async () => {
    const { ctx } = setup(-1);
    const client = await connect(registerAll(ctx));
    const result = await call(client, 'set_read', { id: 'nope', read: true });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('message not found: nope');
  });

  it('move_message: a missing destination folder changes nothing', async () => {
    const { imap, updates, ctx, realUid } = setup(-1);
    const client = await connect(registerAll(ctx));
    const result = await call(client, 'move_message', { id: 'id1', folder: 'INBOX.Nope' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('INBOX.Nope');
    expect(updates).toEqual([]);
    expect(imap.folders.get('INBOX')!.messages.get(realUid)!.flags.has('\\Deleted')).toBe(false);
  });

  it('move_message re-creates the record under the folder-aware id after the IMAP move (ADR-0006)', async () => {
    const { imap, updates, ctx, realUid } = setup(-1);
    const client = await connect(registerAll(ctx));
    const result = json(await call(client, 'move_message', { id: 'id1', folder: 'INBOX.Archive' }));
    expect(imap.calls).toContain(`move(INBOX,${realUid},INBOX.Archive)`);
    const archive = imap.folders.get('INBOX.Archive')!;
    const newUid = [...archive.messages.keys()][0];
    const newId = deriveId({ messageId: '<x@example.com>', folder: 'INBOX.Archive', uidValidity: archive.uidValidity, uid: newUid });
    expect(newId).not.toBe('id1');
    expect(result).toEqual({ id: newId, folder: 'INBOX.Archive' });
    // 新レコードを書いてから旧レコードを消す。生メッセージは同じ s3Key を参照し続ける（S3 は触らない）
    expect(updates.map((u) => u.method)).toEqual(['putMessage', 'deleteMessage']);
    expect(updates[0].args[0]).toMatchObject({
      id: newId,
      messageId: '<x@example.com>',
      folder: 'INBOX.Archive',
      uid: newUid,
      uidValidity: archive.uidValidity,
      s3Key: 'raw/id1.eml',
      subject: 'x',
    });
    expect(updates[0].imapCallsSoFar).toBeGreaterThan(0); // IMAP が先
    expect(updates[1].args).toEqual(['id1']);
  });

  it('move_message derives the new id from the destination location when the message has no Message-ID', async () => {
    const { imap, updates, ctx } = setup(-1, null);
    const client = await connect(registerAll(ctx));
    const result = json(await call(client, 'move_message', { id: 'id1', folder: 'INBOX.Archive' })) as { id: string };
    const archive = imap.folders.get('INBOX.Archive')!;
    const newUid = [...archive.messages.keys()][0];
    expect(result.id).toBe(deriveId({ folder: 'INBOX.Archive', uidValidity: archive.uidValidity, uid: newUid }));
    expect(updates.map((u) => u.method)).toEqual(['putMessage', 'deleteMessage']);
  });

  it('trash_message moves to the trash folder and returns the new id', async () => {
    const { imap, updates, ctx, realUid } = setup(-1);
    const client = await connect(registerAll(ctx));
    const result = json(await call(client, 'trash_message', { id: 'id1' })) as { id: string; folder: string };
    expect(result.folder).toBe(config.trashFolder);
    expect(result.id).toMatch(/^[0-9a-f]{32}$/);
    expect(result.id).not.toBe('id1');
    expect(imap.calls).toContain('specialFolders()');
    expect(imap.calls).toContain(`move(INBOX,${realUid},${config.trashFolder})`);
    expect(updates.map((u) => u.method)).toEqual(['putMessage', 'deleteMessage']);
    expect((updates[0].args[0] as MessageItem).folder).toBe(config.trashFolder);
    expect(imap.folders.get(config.trashFolder)!.messages.size).toBe(1);
  });
});
