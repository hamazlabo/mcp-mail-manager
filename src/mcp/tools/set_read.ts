/** set_read: 既読 / 未読の変更（REQ-030）。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../context';
import { setFlag } from './organize';

export function registerSetRead(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'set_read',
    {
      title: 'Mark read / unread',
      description: 'メッセージを既読（read=true）または未読（read=false）にする',
      inputSchema: { id: z.string(), read: z.boolean() },
    },
    ({ id, read }) => setFlag(ctx, id, { seen: read }),
  );
}
