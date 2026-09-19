/** cancel_scheduled_message: pending の予約を cancelled にしてスケジュールを削除する（REQ-041）。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { cancelScheduled } from '../../core/scheduled';
import type { ToolContext } from '../context';
import { describeError, fail, ok } from './result';

export function registerCancelScheduledMessage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'cancel_scheduled_message',
    {
      title: 'Cancel scheduled message',
      description: '予約送信を取り消す（pending の予約のみ）',
      inputSchema: { scheduleId: z.string() },
    },
    async ({ scheduleId }) => {
      try {
        const result = await cancelScheduled({ ddb: ctx.store.ddb, tableName: ctx.store.tableName }, scheduleId, ctx.now());
        if (!result.cancelled) return fail(`schedule is ${result.status}, only pending can be cancelled`);
        await ctx.scheduler.remove(`mail-mcp-${scheduleId}`);
        return ok({ scheduleId, status: 'cancelled' });
      } catch (err) {
        return fail(describeError(err));
      }
    },
  );
}
