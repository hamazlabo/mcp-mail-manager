import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildForward, newMessageId } from '../../core/compose';
import type { SendOptions } from '../../core/smtp';
import type { ToolContext } from '../context';
import { isToolResult, loadOriginal, sendComposed } from './sending';

/** REQ-022: 元メッセージの本文を引用して転送（添付は転送しない） */
export function registerForwardMessage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'forward_message',
    {
      title: 'Forward message',
      description: 'Forward a message by id with an optional comment. Prefixes "Fwd:" and quotes the original text; attachments are not forwarded.',
      inputSchema: {
        id: z.string().describe('Message id from search_messages'),
        to: z.array(z.string()).min(1),
        comment: z.string().optional(),
      },
    },
    async ({ id, to, comment }) => {
      const original = await loadOriginal(ctx, id);
      if (isToolResult(original)) return original;
      return sendComposed(
        ctx,
        (config) => buildForward({ config, original, to, comment, messageId: newMessageId(config.domain) }) as SendOptions,
      );
    },
  );
}
