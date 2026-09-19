import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHttpServer } from '../../../src/mcp/server';

// SDK 1.30 は最初の registerTool 時に tools/list ハンドラを設定するため、ツール 0 個の tools/list は -32601 になる。
// 登録フック経由でテスト用ツールを 1 つ登録し、フックと tools/list の配線を検証する。
const server = createHttpServer((mcp) => {
  mcp.registerTool('echo', { description: 'test only', inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }));
});
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

describe('mcp http server (REQ-050)', () => {
  it('serves initialize, tools/list and tools/call to the SDK client over Streamable HTTP', async () => {
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl));
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe('mail-mcp');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
    await client.close();
  });

  it('does not reject a request carrying a platform-assigned Mcp-Session-Id header', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': 'dummy-session-from-platform',
      },
      body: JSON.stringify(initializeRequest),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { id: number; result: { serverInfo: { name: string } } };
    expect(body.id).toBe(1);
    expect(body.result.serverInfo.name).toBe('mail-mcp');
  });

  it('answers ping, rejects GET /mcp with 405 and unknown paths with 404', async () => {
    const ping = await fetch(`${baseUrl}/ping`);
    expect(ping.status).toBe(200);
    expect(await ping.text()).toBe('ok');

    const get = await fetch(`${baseUrl}/mcp`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');

    const other = await fetch(`${baseUrl}/other`);
    expect(other.status).toBe(404);
  });
});
