/**
 * MCP サーバの骨格（design.md 3.1, REQ-050）。
 * - createMcpServer: McpServer を組み立てる（ツール登録は register フックで後続タスクが行う）。
 * - createHttpServer: Node http サーバ。POST /mcp をステートレス Streamable HTTP（JSON 応答）で処理する。
 *   リクエストごとに McpServer と Transport を生成し、応答後に閉じる。
 *   プラットフォーム（AgentCore）が付与する Mcp-Session-Id はステートレスモードでは検証されない。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import pkg from '../../package.json';

export type RegisterTools = (server: McpServer) => void;

export function createMcpServer(register?: RegisterTools): McpServer {
  const server = new McpServer({ name: 'mail-mcp', version: pkg.version });
  register?.(server);
  return server;
}

export function createHttpServer(register?: RegisterTools): Server {
  return createServer((req, res) => {
    route(req, res, register).catch((err: unknown) => {
      // 本文・ヘッダ（トークン）は出さない
      console.error(JSON.stringify({ level: 'error', event: 'mcp.request_failed', error: errorName(err) }));
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      if (!res.writableEnded) res.end(jsonRpcError(-32603, 'Internal error'));
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse, register?: RegisterTools): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/ping' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (path !== '/mcp') {
    res.writeHead(404);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(jsonRpcError(-32700, 'Parse error: Invalid JSON'));
    return;
  }

  const server = createMcpServer(register);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } finally {
    await server.close(); // transport も閉じる
  }
}

/** Content-Length の有無に関わらずチャンクを連結して JSON にする */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function jsonRpcError(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
