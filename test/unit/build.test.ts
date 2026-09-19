import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../../src/mcp/tools/index';

/**
 * T-024: `npm run build` の成果物 dist/mcp/main.js を子プロセスで起動し、
 * /ping と MCP の tools/list（13 ツール）が返ることを確認する。
 */
const PORT = 18234;
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_TOOLS = TOOL_NAMES;

let child: ReturnType<typeof spawn> | undefined;

async function waitForPing(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/ping`);
      if (res.ok) return;
    } catch {
      /* まだ起動していない */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function rpc(method: string, params: unknown = {}, id = 1): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return res.json();
}

beforeAll(async () => {
  const build = spawnSync('node', ['build.mjs'], { stdio: 'pipe' });
  expect(build.status, String(build.stderr)).toBe(0);
  expect(existsSync('dist/mcp/main.js')).toBe(true);
  child = spawn('node', ['dist/mcp/main.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      STAGE: 'test',
      TABLE_NAME: 'MailTable-test',
      BUCKET_NAME: 'mail-mcp-raw-test',
      MAIL_SECRET_ARN: 'arn:aws:secretsmanager:ap-northeast-1:000000000000:secret:mail-mcp/test/mail',
      SCHEDULE_GROUP: 'mail-mcp-test',
      SCHEDULER_ROLE_ARN: 'arn:aws:iam::000000000000:role/test',
      SCHEDULED_SEND_FUNCTION_ARN: 'arn:aws:lambda:ap-northeast-1:000000000000:function:test',
      AWS_REGION: 'ap-northeast-1',
    },
    stdio: 'ignore',
  });
  await waitForPing();
}, 60_000);

afterAll(() => {
  child?.kill('SIGTERM');
});

describe('built container entry (dist/mcp/main.js)', () => {
  it('answers GET /ping with 200', async () => {
    const res = await fetch(`${BASE}/ping`);
    expect(res.status).toBe(200);
  });

  it('exposes the 13 mail tools via tools/list', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'build-test', version: '0' },
    });
    expect(init.result?.serverInfo?.name).toBe('mail-mcp');
    const list = await rpc('tools/list', {}, 2);
    const names = (list.result?.tools ?? []).map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });
});
