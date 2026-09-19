import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** façade の `/mcp` に Bearer トークン付きで接続した SDK クライアント */
export async function connectMcp(mcpUrl: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'mail-mcp-smoke', version: '0' });
  await client.connect(transport);
  return client;
}

/** ツール呼出。所要時間（ms）と JSON 化した結果を返す */
export async function callTool<T = unknown>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ ms: number; result: CallToolResult; data: T | undefined }> {
  const start = performance.now();
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const ms = performance.now() - start;
  const first = result.content[0];
  const text = first && first.type === 'text' ? first.text : undefined;
  let data: T | undefined;
  if (!result.isError && text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = undefined;
    }
  }
  return { ms, result, data };
}
