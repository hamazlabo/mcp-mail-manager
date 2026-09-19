import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeImapSession } from '../../../src/core/imap-fake';
import { ImapFlowSession, openImapSession } from '../../../src/core/imap';
import type { MailConfig } from '../../../src/core/types';

const config: MailConfig = {
  domain: 'example.net',
  user: 'someone',
  address: 'someone@example.net',
  password: 'hunter2-secret',
  imapHost: 'mail.example.net',
  imapPort: 993,
  smtpHost: 'mail.example.net',
  smtpPort: 587,
  smtpSecure: false,
  sentFolder: 'INBOX.Sent',
  trashFolder: 'INBOX.Trash',
};

// openImapSession のテスト用: imapflow のコンストラクタ引数を記録する
const ctor = vi.hoisted(() => vi.fn());
vi.mock('imapflow', () => ({
  ImapFlow: class {
    capabilities = new Map();
    constructor(options: unknown) {
      ctor(options);
    }
    async connect() {}
  },
}));

const SAKURA_CAPS = ['IMAP4rev1', 'UIDPLUS', 'CHILDREN', 'NAMESPACE', 'THREAD', 'SORT', 'QUOTA', 'IDLE', 'AUTH=PLAIN', 'ACL'];

/** imapflow の ImapFlow 互換の呼出記録付きフェイク。 */
function fakeClient(caps: string[], opts: { specialUse?: boolean } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const client = {
    calls,
    capabilities: new Map<string, boolean | number>(caps.map((c) => [c, true])),
    mailbox: false as false | { path: string },
    async connect() {
      record('connect');
    },
    async logout() {
      record('logout');
    },
    async list() {
      record('list');
      const sent = { path: 'INBOX.Sent', name: 'Sent', delimiter: '.', flags: new Set<string>() } as Record<string, unknown>;
      const trash = { path: 'INBOX.Trash', name: 'Trash', delimiter: '.', flags: new Set<string>() } as Record<string, unknown>;
      if (opts.specialUse) {
        Object.assign(sent, { specialUse: '\\Sent', specialUseSource: 'extension' });
        Object.assign(trash, { specialUse: '\\Trash', specialUseSource: 'extension' });
      } else {
        // imapflow は SPECIAL-USE 非対応サーバでもフォルダ名から推定する。これは採用しない
        Object.assign(sent, { specialUse: '\\Sent', specialUseSource: 'name' });
      }
      return [{ path: 'INBOX', name: 'INBOX', delimiter: '.', flags: new Set<string>() }, sent, trash];
    },
    async mailboxOpen(path: string) {
      record('mailboxOpen', path);
      this.mailbox = { path };
      return { path, delimiter: '.', uidValidity: 1234n, uidNext: 43, exists: 2, flags: new Set<string>() };
    },
    async search(query: unknown, options: unknown): Promise<number[] | false> {
      record('search', query, options);
      return [7, 9];
    },
    async fetchAll(range: unknown, query: unknown, options: unknown) {
      record('fetchAll', range, query, options);
      return [
        { seq: 1, uid: 7, flags: new Set(['\\Seen']), internalDate: new Date('2026-09-01T00:00:00Z'), source: Buffer.from('raw-7') },
        { seq: 2, uid: 9, flags: new Set(['\\Flagged', '\\Deleted']), internalDate: new Date('2026-09-02T00:00:00Z'), source: Buffer.from('raw-9') },
      ];
    },
    async messageFlagsAdd(range: unknown, flags: string[], options: unknown) {
      record('messageFlagsAdd', range, flags, options);
      return true;
    },
    async messageFlagsRemove(range: unknown, flags: string[], options: unknown) {
      record('messageFlagsRemove', range, flags, options);
      return true;
    },
    async messageMove(range: unknown, destination: string, options: unknown) {
      record('messageMove', range, destination, options);
      return { path: 'INBOX', destination, uidMap: new Map([[7, 101]]) };
    },
    async messageCopy(range: unknown, destination: string, options: unknown) {
      record('messageCopy', range, destination, options);
      return { path: 'INBOX', destination, uidMap: new Map([[7, 55]]) };
    },
    async messageDelete(range: unknown, options: unknown) {
      record('messageDelete', range, options);
      return true;
    },
    async mailboxClose() {
      record('mailboxClose');
      return true;
    },
    async append(path: string, content: Buffer, flags?: string[], idate?: Date) {
      record('append', path, content, flags, idate);
      return { destination: path, uid: 77 };
    },
  };
  return client;
}

const methods = (client: ReturnType<typeof fakeClient>) => client.calls.map((c) => c.method);

describe('ImapFlowSession.move', () => {
  it('uses UID COPY + \\Deleted (never MOVE/EXPUNGE) when the server lacks MOVE (Sakura)', async () => {
    const client = fakeClient(SAKURA_CAPS);
    const session = new ImapFlowSession(client as never, config);

    const moved = await session.move('INBOX', 7, 'INBOX.Trash');

    expect(moved).toEqual({ folder: 'INBOX.Trash', uid: 55 });
    expect(methods(client)).toEqual(['mailboxOpen', 'messageCopy', 'messageFlagsAdd']);
    expect(client.calls[1].args).toEqual([[7], 'INBOX.Trash', { uid: true }]);
    expect(client.calls[2].args).toEqual([[7], ['\\Deleted'], { uid: true }]);
    expect(methods(client)).not.toContain('messageMove');
    expect(methods(client)).not.toContain('messageDelete');
    expect(methods(client)).not.toContain('mailboxClose');
  });

  it('uses UID MOVE when the server advertises MOVE', async () => {
    const client = fakeClient([...SAKURA_CAPS, 'MOVE']);
    const session = new ImapFlowSession(client as never, config);

    const moved = await session.move('INBOX', 7, 'INBOX.Archive');

    expect(moved).toEqual({ folder: 'INBOX.Archive', uid: 101 });
    expect(methods(client)).toEqual(['mailboxOpen', 'messageMove']);
    expect(client.calls[1].args).toEqual([[7], 'INBOX.Archive', { uid: true }]);
  });

  it('propagates the server NO error without leaking the password', async () => {
    const client = fakeClient(SAKURA_CAPS);
    client.messageCopy = async () => {
      throw new Error('Command failed: NO [TRYCREATE] Mailbox does not exist');
    };
    const session = new ImapFlowSession(client as never, config);

    await expect(session.move('INBOX', 7, 'INBOX.Nope')).rejects.toThrow(/TRYCREATE/);
    await expect(session.move('INBOX', 7, 'INBOX.Nope')).rejects.not.toThrow(/hunter2/);
    expect(methods(client)).not.toContain('messageFlagsAdd');
  });
});

describe('ImapFlowSession.specialFolders', () => {
  it('prefers SPECIAL-USE attributes when the server reports them', async () => {
    const client = fakeClient([...SAKURA_CAPS, 'SPECIAL-USE'], { specialUse: true });
    const session = new ImapFlowSession(client as never, { ...config, sentFolder: 'Sent Items', trashFolder: 'Deleted' });

    expect(await session.specialFolders()).toEqual({ sent: 'INBOX.Sent', trash: 'INBOX.Trash' });
    expect((await session.listFolders()).map((f) => f.specialUse)).toEqual([undefined, 'sent', 'trash']);
  });

  it('falls back to the configured folder names when SPECIAL-USE is absent (Sakura)', async () => {
    const client = fakeClient(SAKURA_CAPS);
    const session = new ImapFlowSession(client as never, config);

    expect(await session.specialFolders()).toEqual({ sent: 'INBOX.Sent', trash: 'INBOX.Trash' });
    expect((await session.listFolders()).map((f) => f.specialUse)).toEqual([undefined, undefined, undefined]);
  });
});

describe('ImapFlowSession fetch / flags / append', () => {
  it('selects once, fetches BODY.PEEK source with flags and does not reopen the same mailbox', async () => {
    const client = fakeClient(SAKURA_CAPS);
    const session = new ImapFlowSession(client as never, config);

    expect(await session.select('INBOX')).toEqual({ uidValidity: 1234, uidNext: 43, exists: 2 });
    const messages = await session.fetchMessages('INBOX', [7, 9]);
    expect(messages.map((m) => [m.uid, m.seen, m.flagged, m.deleted, m.raw.toString()])).toEqual([
      [7, true, false, false, 'raw-7'],
      [9, false, true, true, 'raw-9'],
    ]);
    expect(client.calls.filter((c) => c.method === 'mailboxOpen')).toHaveLength(1);
    expect(client.calls.find((c) => c.method === 'fetchAll')?.args).toEqual([
      [7, 9],
      { uid: true, flags: true, internalDate: true, source: true },
      { uid: true },
    ]);
  });

  it('searchUids passes since / uidFrom criteria and normalizes empty results', async () => {
    const client = fakeClient(SAKURA_CAPS);
    const session = new ImapFlowSession(client as never, config);
    const since = new Date('2026-06-21T00:00:00Z');

    expect(await session.searchUids('INBOX', { since })).toEqual([7, 9]);
    expect(client.calls.at(-1)?.args).toEqual([{ since }, { uid: true }]);

    expect(await session.searchUids('INBOX', { uidFrom: 5 })).toEqual([7, 9]);
    expect(client.calls.at(-1)?.args).toEqual([{ uid: '5:*' }, { uid: true }]);

    // `43:*` は最大 UID (9) を超えるためサーバは最後の 1 通 (9) を返す。差分同期では除外する
    expect(await session.searchUids('INBOX', { uidFrom: 43 })).toEqual([]);

    client.search = async () => false;
    expect(await session.searchUids('INBOX', { uidFrom: 5 })).toEqual([]);
  });

  it('setFlags adds / removes \\Seen and \\Flagged by UID and fetchFlags reads uidFrom:* (dropping the n:* overshoot)', async () => {
    const client = fakeClient(SAKURA_CAPS);
    const session = new ImapFlowSession(client as never, config);

    await session.setFlags('INBOX', 7, { seen: true, flagged: false });
    expect(client.calls.slice(1).map((c) => [c.method, ...c.args])).toEqual([
      ['messageFlagsAdd', [7], ['\\Seen'], { uid: true }],
      ['messageFlagsRemove', [7], ['\\Flagged'], { uid: true }],
    ]);

    const flags = await session.fetchFlags('INBOX', 5);
    expect(flags).toEqual([
      { uid: 7, seen: true, flagged: false, deleted: false },
      { uid: 9, seen: false, flagged: true, deleted: true },
    ]);
    expect(client.calls.at(-1)?.args).toEqual(['5:*', { uid: true, flags: true }, { uid: true }]);
    expect(await session.fetchFlags('INBOX', 43)).toEqual([]);
  });

  it('append returns the UID, searchSent looks up the Message-ID in the sent folder, close logs out', async () => {
    const client = fakeClient(SAKURA_CAPS);
    const session = new ImapFlowSession(client as never, config);
    const raw = Buffer.from('Message-ID: <x@example.net>\r\n\r\nhi');

    expect(await session.append('INBOX.Sent', raw, ['\\Seen'])).toEqual({ uid: 77 });
    expect(await session.searchSent('<x@example.net>')).toBe(true);
    expect(client.calls.at(-2)?.args).toEqual(['INBOX.Sent']);
    expect(client.calls.at(-1)?.args).toEqual([{ header: { 'message-id': '<x@example.net>' } }, { uid: true }]);

    client.search = async () => [];
    expect(await session.searchSent('<y@example.net>')).toBe(false);

    await session.close();
    expect(methods(client).at(-1)).toBe('logout');
  });
});

describe('openImapSession', () => {
  beforeEach(() => ctor.mockClear());

  it('logs in with the full mail address (not the local part) over implicit TLS', async () => {
    await openImapSession(config);

    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor.mock.calls[0][0]).toMatchObject({
      host: 'mail.example.net',
      port: 993,
      secure: true,
      auth: { user: 'someone@example.net', pass: 'hunter2-secret' },
      logger: false,
    });
  });
});

describe('FakeImapSession', () => {
  it('stores messages in memory and emulates COPY + \\Deleted moves', async () => {
    const fake = new FakeImapSession({ config, folders: ['INBOX', 'INBOX.Sent', 'INBOX.Trash'] });
    const uid = fake.addMessage('INBOX', Buffer.from('Subject: a\r\n\r\nbody'), { seen: false });

    expect(await fake.specialFolders()).toEqual({ sent: 'INBOX.Sent', trash: 'INBOX.Trash' });
    expect((await fake.listFolders()).map((f) => f.name)).toEqual(['INBOX', 'INBOX.Sent', 'INBOX.Trash']);

    const [msg] = await fake.fetchMessages('INBOX', [uid]);
    expect(msg.raw.toString()).toContain('body');
    expect(msg.seen).toBe(false);

    await fake.setFlags('INBOX', uid, { seen: true, flagged: true });
    const moved = await fake.move('INBOX', uid, 'INBOX.Trash');
    expect(moved.folder).toBe('INBOX.Trash');

    const source = await fake.fetchFlags('INBOX', 1);
    expect(source).toEqual([{ uid, seen: true, flagged: true, deleted: true }]);
    const dest = await fake.fetchFlags('INBOX.Trash', 1);
    expect(dest).toEqual([{ uid: moved.uid, seen: true, flagged: true, deleted: false }]);

    expect(await fake.searchUids('INBOX.Trash', { uidFrom: 1 })).toEqual([moved.uid]);
    await expect(fake.move('INBOX.Trash', moved.uid, 'INBOX.Nope')).rejects.toThrow(/mailbox does not exist: INBOX.Nope/);
    expect(fake.calls.some((c) => c.startsWith('move'))).toBe(true);
  });

  it('searchSent finds appended messages by Message-ID and select reports uidValidity', async () => {
    const fake = new FakeImapSession({ config });
    await fake.append('INBOX.Sent', Buffer.from('Message-ID: <abc@example.net>\r\nSubject: s\r\n\r\nx'));

    expect(await fake.searchSent('<abc@example.net>')).toBe(true);
    expect(await fake.searchSent('<zzz@example.net>')).toBe(false);
    expect((await fake.select('INBOX')).uidValidity).toBeGreaterThan(0);
    await expect(fake.select('Nope')).rejects.toThrow(/mailbox does not exist/);
  });
});
