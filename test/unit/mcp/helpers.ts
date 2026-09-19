/**
 * ツールテスト共通: InMemoryTransport で McpServer に接続し、ToolContext をスタブで組み立てる。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ImapSession } from '../../../src/core/imap';
import type { SendScheduler } from '../../../src/core/scheduler';
import type { MailStore } from '../../../src/core/store';
import type { MailConfig } from '../../../src/core/types';
import type { ToolContext } from '../../../src/mcp/context';
import { createMcpServer } from '../../../src/mcp/server';

export const config: MailConfig = {
  domain: 'example.net',
  user: 'me',
  address: 'me@example.net',
  password: 'hunter2',
  imapHost: 'mail.example.net',
  imapPort: 993,
  smtpHost: 'mail.example.net',
  smtpPort: 587,
  smtpSecure: false,
  sentFolder: 'INBOX.Sent',
  trashFolder: 'INBOX.Trash',
};

export const NOW = new Date('2026-09-19T00:00:00Z');

/** 必要なメソッドだけを差し替えた ToolContext を作る */
export function makeCtx(overrides: {
  store?: Partial<MailStore>;
  imap?: ImapSession;
  scheduler?: Partial<SendScheduler>;
  now?: Date;
} = {}): ToolContext {
  return {
    store: overrides.store as MailStore,
    loadConfig: async () => config,
    openImap: async () => {
      if (!overrides.imap) throw new Error('imap not provided');
      return overrides.imap;
    },
    createSmtp: () => {
      throw new Error('smtp not provided');
    },
    scheduler: { create: async () => {}, remove: async () => {}, ...overrides.scheduler },
    now: () => overrides.now ?? NOW,
  };
}

export async function connect(register: (server: McpServer) => void): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(register);
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

export function text(result: CallToolResult): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('no text content');
  return first.text;
}

export function json<T = unknown>(result: CallToolResult): T {
  if (result.isError) throw new Error(`tool failed: ${text(result)}`);
  return JSON.parse(text(result)) as T;
}
