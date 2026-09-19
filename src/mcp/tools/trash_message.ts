/** trash_message: ゴミ箱（Trash 相当フォルダ）へ移動する（REQ-032）。完全削除（EXPUNGE）はしない。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../context';
import { moveTo } from './organize';

export function registerTrashMessage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'trash_message',
    {
      title: 'Trash message',
      description: 'メッセージをゴミ箱フォルダへ移動する（完全削除はしない）',
      inputSchema: { id: z.string() },
    },
    ({ id }) => moveTo(ctx, id, async (imap) => (await imap.specialFolders()).trash),
  );
}
