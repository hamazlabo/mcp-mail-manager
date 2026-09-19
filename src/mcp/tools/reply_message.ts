import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildReply, newMessageId } from '../../core/compose';
import type { SendOptions } from '../../core/smtp';
import type { ToolContext } from '../context';
import { isToolResult, loadOriginal, sendComposed } from './sending';

/** REQ-021: 元メッセージにスレッドを紐づけた返信 */
export function registerReplyMessage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'reply_message',
    {
      title: 'Reply to message',
      description: 'Reply to a message by id. Sets In-Reply-To / References and prefixes "Re:". replyAll includes To/Cc except yourself.',
      inputSchema: {
        id: z.string().describe('Message id from search_messages'),
        body: z.string().describe('Plain-text body'),
        replyAll: z.boolean().optional(),
      },
    },
    async ({ id, body, replyAll }) => {
      const original = await loadOriginal(ctx, id);
      if (isToolResult(original)) return original;
      return sendComposed(
        ctx,
        (config) => buildReply({ config, original, body, replyAll, messageId: newMessageId(config.domain) }) as SendOptions,
      );
    },
  );
}
