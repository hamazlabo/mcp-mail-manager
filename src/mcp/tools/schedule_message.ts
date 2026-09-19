/**
 * schedule_message: 予約送信の作成（REQ-040）。
 * DynamoDB に pending を書いてから EventBridge Scheduler に一回限りスケジュールを登録する。登録に失敗したら pending を消す。
 */
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildNew, newMessageId } from '../../core/compose';
import { validateSendAt } from '../../core/scheduled';
import type { ScheduledItem } from '../../core/types';
import type { ToolContext } from '../context';
import { describeError, fail, ok } from './result';

const inputSchema = {
  sendAt: z.string().describe('送信日時（タイムゾーン付き ISO 8601。例: 2026-10-01T18:00:00+09:00）'),
  to: z.array(z.string()).min(1),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string(),
  body: z.string().describe('プレーンテキスト本文'),
};

export function registerScheduleMessage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'schedule_message',
    {
      title: 'Schedule message',
      description: '指定日時（1 年以内）にサーバ側から 1 回だけ送信する予約を作り、予約 ID を返す',
      inputSchema,
    },
    async ({ sendAt, to, cc, bcc, subject, body }) => {
      let sendAtDate: Date;
      try {
        sendAtDate = validateSendAt(sendAt, ctx.now());
      } catch (err) {
        return fail(describeError(err));
      }
      const config = await ctx.loadConfig();
      const messageId = newMessageId(config.domain);
      try {
        buildNew({ config, to, cc, bcc, subject, body, messageId }); // 宛先検証のみ（送信はしない）
      } catch (err) {
        return fail(describeError(err, config));
      }

      const scheduleId = randomUUID();
      const item: ScheduledItem = {
        scheduleId,
        status: 'pending',
        sendAt: sendAtDate.toISOString(),
        to,
        cc: cc ?? [],
        bcc: bcc ?? [],
        subject,
        body,
        messageId,
        scheduleName: `mail-mcp-${scheduleId}`,
        attempts: 0,
        createdAt: ctx.now().toISOString(),
      };
      await ctx.store.putScheduled(item);
      try {
        await ctx.scheduler.create({ scheduleName: item.scheduleName, scheduleId, sendAt: sendAtDate });
      } catch (err) {
        await ctx.store.deleteScheduled(scheduleId);
        return fail(describeError(err, config));
      }
      return ok({ scheduleId, sendAt: item.sendAt });
    },
  );
}
