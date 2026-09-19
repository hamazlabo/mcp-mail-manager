/** set_flagged: フラグの付与 / 解除（REQ-033）。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../context';
import { setFlag } from './organize';

export function registerSetFlagged(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'set_flagged',
    {
      title: 'Flag / unflag',
      description: 'メッセージにフラグ（\\Flagged）を付ける（flagged=true）または外す（flagged=false）',
      inputSchema: { id: z.string(), flagged: z.boolean() },
    },
    ({ id, flagged }) => setFlag(ctx, id, { flagged }),
  );
}
