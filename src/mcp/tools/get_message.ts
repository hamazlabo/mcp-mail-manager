/** get_message: S3 の生メッセージを解析してヘッダ・テキスト本文・添付メタ情報を返す（REQ-011）。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parseMessage } from '../../core/mime';
import type { ToolContext } from '../context';
import { describeError, fail, ok } from './result';

export function registerGetMessage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_message',
    {
      title: 'Get message',
      description: 'メッセージ ID を指定して、ヘッダ・テキスト本文・添付ファイルのメタ情報（本体は含まない）を返す',
      inputSchema: { id: z.string().describe('search_messages が返した id') },
    },
    async ({ id }) => {
      try {
        const item = await ctx.store.getMessage(id);
        const raw = item && (await ctx.store.getRaw(id));
        if (!raw) return fail(`message not found: ${id}`);
        const parsed = await parseMessage(raw);
        return ok({ id, headers: parsed.headers, text: parsed.text, attachments: parsed.attachments });
      } catch (err) {
        return fail(describeError(err));
      }
    },
  );
}
