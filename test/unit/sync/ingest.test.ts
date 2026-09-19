import { describe, expect, it } from 'vitest';
import { FakeImapSession } from '../../../src/core/imap-fake';
import type { MailConfig } from '../../../src/core/types';
import type { FolderPlan } from '../../../src/sync/folders';
import { ingestFolder, type SyncClock } from '../../../src/sync/ingest';
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
const since = new Date('2026-06-21T00:00:00.000Z');

function eml(n: number, messageId = `<msg-${n}@example.com>`): Buffer {
  return Buffer.from(
    [
      'From: Alice <alice@example.com>',
      'To: someone@example.net',
      `Subject: message ${n}`,
      `Message-ID: ${messageId}`,
      'Date: Mon, 01 Sep 2026 10:15:00 +0900',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      `body ${n}`,
    ].join('\r\n'),
  );
}

function plentyOfTime(): SyncClock {
  return { now: () => now, remainingMs: () => 10 * 60_000 };
}

function setup(count: number) {
  const imap = new FakeImapSession({ config });
  const store = new FakeStore();
  for (let n = 1; n <= count; n++) imap.addMessage('INBOX', eml(n), { internalDate: new Date('2026-09-01T01:15:00.000Z') });
  return { imap, store };
}

const initial: FolderPlan = { mode: 'initial', uidValidity: 1000, since };

describe('ingestFolder', () => {
  it('120 通を 50 通ずつ 3 バッチで取り込み、バッチごとに lastUid を進め、最後に initialDone にする', async () => {
    const { imap, store } = setup(120);

    const result = await ingestFolder({ imap, store: store.asStore(), folder: 'INBOX', plan: initial, clock: plentyOfTime() });

    expect(result).toEqual({ complete: true, ingested: 120 });
    expect(imap.calls.filter((c) => c.startsWith('fetchMessages'))).toHaveLength(3);
    expect(store.syncStateHistory.map((s) => [s.lastUid, s.initialDone])).toEqual([
      [50, false],
      [100, false],
      [120, false],
      [120, true],
    ]);
    expect(store.messages.size).toBe(120);
    expect(store.raws.size).toBe(120);
    const first = [...store.messages.values()].find((m) => m.uid === 1)!;
    expect(first).toMatchObject({
      folder: 'INBOX',
      uidValidity: 1000,
      subject: 'message 1',
      from: 'Alice <alice@example.com>',
      to: ['someone@example.net'],
      messageId: '<msg-1@example.com>',
      receivedAt: '2026-09-01T01:15:00.000Z',
      seen: false,
      flagged: false,
      hasAttachments: false,
      s3Key: `raw/${first.id}.eml`,
    });
    expect(first.size).toBe(eml(1).length);
  });

  it('同じ Message-ID を 2 回取り込んでも同じ id に上書きされ重複しない', async () => {
    const { imap, store } = setup(3);

    await ingestFolder({ imap, store: store.asStore(), folder: 'INBOX', plan: initial, clock: plentyOfTime() });
    await ingestFolder({ imap, store: store.asStore(), folder: 'INBOX', plan: initial, clock: plentyOfTime() });

    expect(store.calls.filter((c) => c.startsWith('putMessage'))).toHaveLength(6);
    expect(store.messages.size).toBe(3);
    expect(store.raws.size).toBe(3);
  });

  it('時間予算が無くなったら lastUid を保存して中断し、再実行では残りだけ取り込む', async () => {
    const { imap, store } = setup(120);
    let calls = 0;
    // 1 バッチ目の前は余裕あり、2 バッチ目の前で残り時間切れ
    const tight: SyncClock = { now: () => now, remainingMs: () => (calls++ === 0 ? 10 * 60_000 : 30_000) };

    const first = await ingestFolder({ imap, store: store.asStore(), folder: 'INBOX', plan: initial, clock: tight });
    expect(first).toEqual({ complete: false, ingested: 50 });
    expect(store.syncStates.get('INBOX')).toMatchObject({ lastUid: 50, initialDone: false, uidValidity: 1000 });
    expect(store.messages.size).toBe(50);

    const resume: FolderPlan = { ...initial, uidFrom: 51 };
    const second = await ingestFolder({ imap, store: store.asStore(), folder: 'INBOX', plan: resume, clock: plentyOfTime() });
    expect(second).toEqual({ complete: true, ingested: 70 });
    const fetched = imap.calls.filter((c) => c.startsWith('fetchMessages')).slice(1);
    expect(fetched.every((c) => !/\[1,/.test(c))).toBe(true);
    expect(store.messages.size).toBe(120);
    expect(store.syncStates.get('INBOX')).toMatchObject({ lastUid: 120, initialDone: true });
  });

  it('\\Deleted 付きのメッセージは取り込まない', async () => {
    const { imap, store } = setup(3);
    imap.folders.get('INBOX')!.messages.get(2)!.flags.add('\\Deleted');

    const result = await ingestFolder({ imap, store: store.asStore(), folder: 'INBOX', plan: initial, clock: plentyOfTime() });

    expect(result).toEqual({ complete: true, ingested: 2 });
    expect([...store.messages.values()].map((m) => m.uid).sort()).toEqual([1, 3]);
  });

  it('差分モードは uidFrom 以降だけを検索し、0 件なら lastUid を uidFrom-1 のまま完了にする', async () => {
    const { imap, store } = setup(5);
    const plan: FolderPlan = { mode: 'incremental', uidValidity: 1000, uidFrom: 6 };

    const result = await ingestFolder({ imap, store: store.asStore(), folder: 'INBOX', plan, clock: plentyOfTime() });

    expect(result).toEqual({ complete: true, ingested: 0 });
    expect(imap.calls).toContain('searchUids(INBOX,{"uidFrom":6})');
    expect(store.syncStates.get('INBOX')).toMatchObject({ lastUid: 5, initialDone: true });
  });
});
