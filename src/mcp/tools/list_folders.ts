/** list_folders: 同期済みフォルダの名前・件数・未読数・特殊フォルダ種別（REQ-012）。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context';
import { describeError, fail, ok } from './result';

export function registerListFolders(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_folders',
    {
      title: 'List folders',
      description: '同期済みのメールフォルダ一覧（名前・メッセージ数・未読数・sent/trash の種別）を返す',
    },
    async () => {
      try {
        const folders = await ctx.store.listFolders();
        return ok(folders.map((f) => ({ name: f.name, total: f.total, unread: f.unread, specialUse: f.specialUse })));
      } catch (err) {
        return fail(describeError(err));
      }
    },
  );
}
