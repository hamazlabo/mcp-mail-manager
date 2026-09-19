/** move_message: フォルダ移動（REQ-031）。移動先が無ければエラーで何も変えない。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../context';
import { moveTo } from './organize';

export function registerMoveMessage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'move_message',
    {
      title: 'Move message',
      description: 'メッセージを指定フォルダへ移動する（list_folders のフォルダ名を指定）。移動後は id が変わるので、以後は戻り値の id を使う',
      inputSchema: { id: z.string(), folder: z.string().describe('移動先フォルダ名') },
    },
    ({ id, folder }) => moveTo(ctx, id, async () => folder),
  );
}
