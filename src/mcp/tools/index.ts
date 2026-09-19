/** 13 ツールの一括登録（design.md 3.1 のツール一覧）。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context';
import { registerCancelScheduledMessage } from './cancel_scheduled_message';
import { registerForwardMessage } from './forward_message';
import { registerGetMessage } from './get_message';
import { registerListFolders } from './list_folders';
import { registerListScheduledMessages } from './list_scheduled_messages';
import { registerMoveMessage } from './move_message';
import { registerReplyMessage } from './reply_message';
import { registerScheduleMessage } from './schedule_message';
import { registerSearchMessages } from './search_messages';
import { registerSendMessage } from './send_message';
import { registerSetFlagged } from './set_flagged';
import { registerSetRead } from './set_read';
import { registerTrashMessage } from './trash_message';

const REGISTRARS = [
  registerListFolders,
  registerSearchMessages,
  registerGetMessage,
  registerSendMessage,
  registerReplyMessage,
  registerForwardMessage,
  registerSetRead,
  registerSetFlagged,
  registerMoveMessage,
  registerTrashMessage,
  registerScheduleMessage,
  registerListScheduledMessages,
  registerCancelScheduledMessage,
];

/** 公開ツール名（正常性テスト・ビルドテストが件数と名前を照合する） */
export const TOOL_NAMES = [
  'list_folders',
  'search_messages',
  'get_message',
  'send_message',
  'reply_message',
  'forward_message',
  'set_read',
  'set_flagged',
  'move_message',
  'trash_message',
  'schedule_message',
  'list_scheduled_messages',
  'cancel_scheduled_message',
] as const;

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  for (const register of REGISTRARS) register(server, ctx);
}
