import { describe, expect, it } from 'vitest';
import { FakeImapSession } from '../../../src/core/imap-fake';
import type { MailConfig } from '../../../src/core/types';
import { planFolder, saveFolders } from '../../../src/sync/folders';
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
const DAY = 86_400_000;

describe('planFolder', () => {
  it('SyncState が無ければ初回モードで SINCE は 90 日前', async () => {
    const imap = new FakeImapSession({ config });
    const store = new FakeStore();
    const plan = await planFolder({ imap, store: store.asStore(), folder: 'INBOX', now });
    expect(plan).toEqual({ mode: 'initial', uidValidity: 1000, since: new Date(now.getTime() - 90 * DAY) });
  });

  it('UIDVALIDITY が変わっていれば再取込モード', async () => {
    const imap = new FakeImapSession({ config });
    const store = new FakeStore();
    store.syncStates.set('INBOX', { folder: 'INBOX', uidValidity: 999, lastUid: 50, initialDone: true, updatedAt: '' });
    const plan = await planFolder({ imap, store: store.asStore(), folder: 'INBOX', now });
    expect(plan).toEqual({ mode: 'reset', uidValidity: 1000, since: new Date(now.getTime() - 90 * DAY) });
  });

  it('UIDVALIDITY が一致し初回完了済みなら lastUid+1 からの差分モード', async () => {
    const imap = new FakeImapSession({ config });
    const store = new FakeStore();
    store.syncStates.set('INBOX', { folder: 'INBOX', uidValidity: 1000, lastUid: 50, initialDone: true, updatedAt: '' });
    const plan = await planFolder({ imap, store: store.asStore(), folder: 'INBOX', now });
    expect(plan).toEqual({ mode: 'incremental', uidValidity: 1000, uidFrom: 51 });
  });

  it('初回の途中（initialDone=false）なら初回モードの続き', async () => {
    const imap = new FakeImapSession({ config });
    const store = new FakeStore();
    store.syncStates.set('INBOX', { folder: 'INBOX', uidValidity: 1000, lastUid: 50, initialDone: false, updatedAt: '' });
    const plan = await planFolder({ imap, store: store.asStore(), folder: 'INBOX', now });
    expect(plan).toEqual({
      mode: 'initial',
      uidValidity: 1000,
      since: new Date(now.getTime() - 90 * DAY),
      uidFrom: 51,
    });
  });
});

describe('saveFolders', () => {
  it('全フォルダを Folder アイテムとして保存し、特殊フォルダを設定値から識別し、既存の total / unread を維持する', async () => {
    const imap = new FakeImapSession({ config });
    const store = new FakeStore();
    store.folders.set('INBOX', { name: 'INBOX', delimiter: '.', total: 12, unread: 3, lastSyncAt: '2026-09-18T00:00:00.000Z' });

    const names = await saveFolders({ imap, store: store.asStore(), now });

    expect(names).toEqual(['INBOX', 'INBOX.Sent', 'INBOX.Trash']);
    expect(store.folders.get('INBOX')).toMatchObject({ total: 12, unread: 3, specialUse: undefined });
    expect(store.folders.get('INBOX.Sent')).toMatchObject({ specialUse: 'sent', total: 0, unread: 0 });
    expect(store.folders.get('INBOX.Trash')).toMatchObject({ specialUse: 'trash', delimiter: '.' });
  });
});
