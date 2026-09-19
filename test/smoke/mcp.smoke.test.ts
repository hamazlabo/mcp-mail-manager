import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../../src/mcp/tools/index';
import { getAccessToken } from './auth';
import { callTool, connectMcp } from './mcp-client';
import { loadOutputs } from './outputs';

/**
 * 正常性テスト（NFR-006）。デプロイ済み環境に対して design.md 9 章のユースケースを実行する。
 * 送信・整理ツールは対象外（実メールボックスを変更しない）。
 */
const outputs = loadOutputs();
const mcpUrl = outputs.McpUrl;
const facade = new URL(mcpUrl).origin;

// NFR-005 の上限（コールドスタートは initialize で吸収する）
const LIMIT_MS = { fast: 2_000, read: 3_000 };

let token: string;
let client: Client;

beforeAll(async () => {
  token = await getAccessToken(outputs);
  client = await connectMcp(mcpUrl, token); // initialize（コールドスタート込み）
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe('REQ-051: 認証', () => {
  it('トークン無しの POST /mcp は 401 と façade の PRM を指す WWW-Authenticate を返す', async () => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${facade}/.well-known/oauth-protected-resource"`,
    );
  });

  it('well-known 2 本が 200 で、PRM は /mcp を、AS メタデータは S256 を広告する', async () => {
    const prm = await fetch(`${facade}/.well-known/oauth-protected-resource`);
    expect(prm.status).toBe(200);
    const prmJson = (await prm.json()) as { resource: string; authorization_servers: string[] };
    expect(prmJson.resource).toBe(mcpUrl);
    expect(prmJson.authorization_servers).toEqual([facade]);

    const as = await fetch(`${facade}/.well-known/oauth-authorization-server`);
    expect(as.status).toBe(200);
    const asJson = (await as.json()) as Record<string, unknown>;
    expect(asJson.code_challenge_methods_supported).toEqual(['S256']);
    expect(String(asJson.authorization_endpoint)).toContain(outputs.CognitoDomain);
    expect(String(asJson.token_endpoint)).toContain('/oauth2/token');
  });
});

describe('REQ-050: MCP', () => {
  it('tools/list が 13 ツールを返す', async () => {
    const start = performance.now();
    const { tools } = await client.listTools();
    expect(performance.now() - start).toBeLessThan(LIMIT_MS.fast);
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });
});

describe('REQ-012 / REQ-010 / REQ-011: 閲覧', () => {
  it('list_folders → search_messages → get_message', async () => {
    const folders = await callTool<{ name: string }[]>(client, 'list_folders');
    expect(folders.result.isError).toBeFalsy();
    expect(folders.ms).toBeLessThan(LIMIT_MS.fast);

    const search = await callTool<{ messages: { id: string }[] }>(client, 'search_messages', { limit: 5 });
    expect(search.result.isError).toBeFalsy();
    expect(search.ms).toBeLessThan(LIMIT_MS.fast);
    expect(Array.isArray(search.data?.messages)).toBe(true);

    const first = search.data?.messages[0];
    if (!first) return; // 同期済みメールが 0 件なら検索の空応答までで合格
    const message = await callTool<{ id: string; text: string }>(client, 'get_message', { id: first.id });
    expect(message.result.isError).toBeFalsy();
    expect(message.ms).toBeLessThan(LIMIT_MS.read);
    expect(message.data?.id).toBe(first.id);
  });
});

describe('REQ-040 / REQ-041: 予約', () => {
  it('schedule_message（11 か月後）→ list_scheduled_messages に pending → cancel_scheduled_message', async () => {
    const sendAt = new Date();
    sendAt.setUTCMonth(sendAt.getUTCMonth() + 11);
    const scheduled = await callTool<{ scheduleId: string }>(client, 'schedule_message', {
      sendAt: sendAt.toISOString(),
      to: ['smoke-test@example.invalid'],
      subject: 'mail-mcp smoke test (will be cancelled)',
      body: 'This scheduled message is created by the smoke test and cancelled immediately.',
    });
    expect(scheduled.result.isError, JSON.stringify(scheduled.result.content)).toBeFalsy();
    expect(scheduled.ms).toBeLessThan(LIMIT_MS.fast);
    const scheduleId = scheduled.data!.scheduleId;

    try {
      const list = await callTool<{ scheduleId: string; status: string }[]>(client, 'list_scheduled_messages', {
        status: 'pending',
      });
      expect(list.ms).toBeLessThan(LIMIT_MS.fast);
      expect(list.data?.some((s) => s.scheduleId === scheduleId && s.status === 'pending')).toBe(true);
    } finally {
      const cancelled = await callTool<{ status: string }>(client, 'cancel_scheduled_message', { scheduleId });
      expect(cancelled.result.isError, JSON.stringify(cancelled.result.content)).toBeFalsy();
      expect(cancelled.ms).toBeLessThan(LIMIT_MS.fast);
      expect(cancelled.data?.status).toBe('cancelled');
    }
  });
});
