import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildNew, newMessageId } from '../../core/compose';
import type { SendOptions } from '../../core/smtp';
import type { ToolContext } from '../context';
import { sendComposed } from './sending';

/** REQ-020: プレーンテキストの新規送信。From は設定値固定 */
export function registerSendMessage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'send_message',
    {
      title: 'Send message',
      description: 'Send a new plain-text email from the configured account. Returns the Message-ID.',
      inputSchema: {
        to: z.array(z.string()).min(1).describe('Recipients (To)'),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string(),
        body: z.string().describe('Plain-text body'),
      },
    },
    ({ to, cc, bcc, subject, body }) =>
      sendComposed(
        ctx,
        (config) => buildNew({ config, to, cc, bcc, subject, body, messageId: newMessageId(config.domain) }) as SendOptions,
      ),
  );
}
