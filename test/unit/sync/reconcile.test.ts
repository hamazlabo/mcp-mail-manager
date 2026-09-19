import { describe, expect, it } from 'vitest';
import { FakeImapSession } from '../../../src/core/imap-fake';
import type { MailConfig, MessageItem } from '../../../src/core/types';
import { reconcileFolder } from '../../../src/sync/reconcile';
import { FakeStore } from './fake-store';

const config: MailConfig = {
  domain: 'example.net',
  user: 'someone',
  address: 'someone@example.net',
  password: 'secret',
  imapHost: 'mail.example.net',
  imapPort: 993,
  smtpHost: 'mail.example.net',
  smtpPort: 587,
  smtpSecure: false,
  sentFolder: 'INBOX.Sent',
  trashFolder: 'INBOX.Trash',
};

const now = new Date('2026-09-19T00:00:00.000Z');

function item(id: string, folder: string, uid: number, flags: { seen?: boolean; flagged?: boolean } = {}): MessageItem {
  return {
    id,
    messageId: `<${id}@example.com>`,
    folder,
    uid,
    uidValidity: 1000,
    subject: `s-${id}`,
    from: 'alice@example.com',
    to: ['someone@example.net'],
    cc: [],
    receivedAt: '2026-09-01T00:00:00.000Z',
    seen: flags.seen ?? false,
    flagged: flags.flagged ?? false,
    hasAttachments: false,
    attachments: [],
    size: 10,
    s3Key: `raw/${id}.eml`,
    subjectLower: '',
    fromLower: '',
    toLower: '',
  };
}

function setup() {
  const imap = new FakeImapSession({ config });
  const store = new FakeStore();
  store.folders.set('INBOX', { name: 'INBOX', delimiter: '.', total: 0, unread: 0, lastSyncAt: '2026-09-18T00:00:00.000Z' });
  return { imap, store };
}

describe('reconcileFolder', () => {
  it('メールクライアント側で既読になった UID を DynamoDB でも seen=true にする', async () => {
    const { imap, store } = setup();
    const uid = imap.addMessage('INBOX', Buffer.from('x'), { seen: true });
    store.messages.set('m1', item('m1', 'INBOX', uid, { seen: false }));

    await reconcileFolder({ imap, store: store.asStore(), folder: 'INBOX', now });

    expect(store.calls).toContain('updateFlags(m1,{"seen":true})');
    expect(store.messages.get('m1')!.seen).toBe(true);
  });

  it('フラグの変化だけなら flagged のみ更新し、変化が無ければ更新しない', async () => {
    const { imap, store } = setup();
    const flaggedUid = imap.addMessage('INBOX', Buffer.from('x'), { flagged: true });
    const sameUid = imap.addMessage('INBOX', Buffer.from('y'), { seen: true });
    store.messages.set('m1', item('m1', 'INBOX', flaggedUid));
    store.messages.set('m2', item('m2', 'INBOX', sameUid, { seen: true }));

    await reconcileFolder({ imap, store: store.asStore(), folder: 'INBOX', now });

    expect(store.calls.filter((c) => c.startsWith('updateFlags'))).toEqual(['updateFlags(m1,{"flagged":true})']);
  });

  it('他フォルダで再登録済み（移動）の id は削除しない', async () => {
    const { imap, store } = setup();
    // GSI の結果整合性で古い所属が見えた状況: 既知集合は INBOX/uid 1 だが実体は INBOX.Archive に移っている
    store.messages.set('m1', item('m1', 'INBOX.Archive', 9));
    store.listFolderUids = async () => [{ id: 'm1', uid: 1, seen: false, flagged: false }];

    await reconcileFolder({ imap, store: store.asStore(), folder: 'INBOX', now });

    expect(store.calls.some((c) => c.startsWith('deleteMessage') || c.startsWith('deleteRaw'))).toBe(false);
    expect(store.messages.has('m1')).toBe(true);
  });

  it('IMAP から消えた id と \\Deleted 付きの id は DynamoDB と S3 から削除する', async () => {
    const { imap, store } = setup();
    const keep = imap.addMessage('INBOX', Buffer.from('a'));
    const deleted = imap.addMessage('INBOX', Buffer.from('b'));
    imap.folders.get('INBOX')!.messages.get(deleted)!.flags.add('\\Deleted');
    for (const [id, uid] of [
      ['keep', keep],
      ['gone', 99],
      ['del', deleted],
    ] as const) {
      store.messages.set(id, item(id, 'INBOX', uid));
      store.raws.set(id, Buffer.from(id));
    }

    await reconcileFolder({ imap, store: store.asStore(), folder: 'INBOX', now });

    expect([...store.messages.keys()]).toEqual(['keep']);
    expect([...store.raws.keys()]).toEqual(['keep']);
    expect(store.calls).toEqual(expect.arrayContaining(['deleteMessage(gone)', 'deleteRaw(gone)', 'deleteMessage(del)', 'deleteRaw(del)']));
  });

  it('Folder の total（\\Deleted を除く件数）と unread を更新し、specialUse と delimiter を保持する', async () => {
    const { imap, store } = setup();
    store.folders.set('INBOX.Sent', { name: 'INBOX.Sent', delimiter: '.', specialUse: 'sent', total: 0, unread: 0, lastSyncAt: '' });
    const u1 = imap.addMessage('INBOX.Sent', Buffer.from('a'), { seen: true });
    const u2 = imap.addMessage('INBOX.Sent', Buffer.from('b'));
    const u3 = imap.addMessage('INBOX.Sent', Buffer.from('c'));
    imap.folders.get('INBOX.Sent')!.messages.get(u3)!.flags.add('\\Deleted');
    imap.addMessage('INBOX.Sent', Buffer.from('d'));
    store.messages.set('a', item('a', 'INBOX.Sent', u1, { seen: true }));
    store.messages.set('b', item('b', 'INBOX.Sent', u2));

    await reconcileFolder({ imap, store: store.asStore(), folder: 'INBOX.Sent', now });

    expect(store.folders.get('INBOX.Sent')).toEqual({
      name: 'INBOX.Sent',
      delimiter: '.',
      specialUse: 'sent',
      total: 3,
      unread: 2,
      lastSyncAt: now.toISOString(),
    });
  });
});
