/** list_scheduled_messages: 予約の一覧（REQ-041）。本文は含めない。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../context';
import { describeError, fail, ok } from './result';

export function registerListScheduledMessages(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_scheduled_messages',
    {
      title: 'List scheduled messages',
      description: '予約送信の一覧（予約 ID・状態・送信予定日時・宛先・件名・失敗理由）を返す',
      inputSchema: { status: z.enum(['pending', 'sending', 'sent', 'failed', 'cancelled']).optional() },
    },
    async ({ status }) => {
      try {
        const items = await ctx.store.listScheduled(status);
        return ok(
          items.map(({ scheduleId, status, sendAt, to, subject, error }) => ({ scheduleId, status, sendAt, to, subject, error })),
        );
      } catch (err) {
        return fail(describeError(err));
      }
    },
  );
}
