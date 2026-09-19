import { describe, expect, it } from 'vitest';
import { FakeImapSession } from '../../../src/core/imap-fake';
import type { MailConfig } from '../../../src/core/types';
import { runSync } from '../../../src/sync/handler';
import type { SyncClock } from '../../../src/sync/ingest';
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

function eml(n: number): Buffer {
  return Buffer.from(`From: a@example.com\r\nTo: someone@example.net\r\nSubject: m${n}\r\nMessage-ID: <m${n}@example.com>\r\n\r\nbody`);
}

function deps(imap: FakeImapSession, store: FakeStore, clock: SyncClock) {
  return { store: store.asStore(), loadConfig: async () => config, openImap: async () => imap, clock };
}

describe('runSync', () => {
  it('取込が未完了なら照合フェーズを実行せず、セッションは閉じる', async () => {
    const imap = new FakeImapSession({ config });
    const store = new FakeStore();
    for (let n = 1; n <= 60; n++) imap.addMessage('INBOX', eml(n));
    let checks = 0;
    const clock: SyncClock = { now: () => now, remainingMs: () => (checks++ === 0 ? 10 * 60_000 : 30_000) };

    const result = await runSync(deps(imap, store, clock));

    expect(result).toEqual({ complete: false, folders: 3 });
    expect(imap.calls.some((c) => c.startsWith('fetchFlags'))).toBe(false);
    expect(imap.calls.at(-1)).toBe('close()');
    expect(store.syncStates.get('INBOX')).toMatchObject({ lastUid: 50, initialDone: false });
  });

  it('全フォルダの取込が完了したら各フォルダで照合フェーズを実行する', async () => {
    const imap = new FakeImapSession({ config });
    const store = new FakeStore();
    imap.addMessage('INBOX', eml(1));
    const clock: SyncClock = { now: () => now, remainingMs: () => 10 * 60_000 };

    const result = await runSync(deps(imap, store, clock));

    expect(result).toEqual({ complete: true, folders: 3 });
    expect(imap.calls.filter((c) => c.startsWith('fetchFlags'))).toEqual([
      'fetchFlags(INBOX,1)',
      'fetchFlags(INBOX.Sent,1)',
      'fetchFlags(INBOX.Trash,1)',
    ]);
    expect(store.folders.get('INBOX')).toMatchObject({ total: 1, unread: 1, lastSyncAt: now.toISOString() });
    expect(store.messages.size).toBe(1);
  });

  it('UIDVALIDITY が変わったフォルダは SyncState を捨ててから全件再取込する', async () => {
    const imap = new FakeImapSession({ config });
    const store = new FakeStore();
    imap.addMessage('INBOX', eml(1));
    store.syncStates.set('INBOX', { folder: 'INBOX', uidValidity: 1, lastUid: 500, initialDone: true, updatedAt: '' });
    const clock: SyncClock = { now: () => now, remainingMs: () => 10 * 60_000 };

    await runSync(deps(imap, store, clock));

    const order = store.calls.filter((c) => /^(deleteSyncState|putSyncState)\(INBOX,/.test(c) || c === 'deleteSyncState(INBOX)');
    expect(order[0]).toBe('deleteSyncState(INBOX)');
    expect(store.syncStates.get('INBOX')).toMatchObject({ uidValidity: 1000, lastUid: 1, initialDone: true });
    expect(store.messages.size).toBe(1);
  });
});
