/**
 * 整理系ツールの共通処理（REQ-030〜033）。順序は必ず「IMAP 成功 → DynamoDB 更新」。
 * IMAP が失敗したら DynamoDB は変更せず isError を返す。
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { deriveId } from '../../core/ids';
import type { ImapSession } from '../../core/imap';
import type { MailConfig, MessageItem } from '../../core/types';
import { withImap, type ToolContext } from '../context';
import { describeError, fail, ok } from './result';

/** メッセージを引いて IMAP セッション上で fn を実行し、結果を ok / fail に整形する */
export async function organize(
  ctx: ToolContext,
  id: string,
  fn: (item: MessageItem, imap: ImapSession) => Promise<unknown>,
): Promise<CallToolResult> {
  const item = await ctx.store.getMessage(id);
  if (!item) return fail(`message not found: ${id}`);
  let config: MailConfig | undefined;
  try {
    return ok(
      await withImap(ctx, (imap, cfg) => {
        config = cfg;
        return fn(item, imap);
      }),
    );
  } catch (err) {
    return fail(describeError(err, config));
  }
}

/** \Seen / \Flagged を IMAP で変更してから DynamoDB に反映する */
export function setFlag(ctx: ToolContext, id: string, flags: { seen?: boolean; flagged?: boolean }): Promise<CallToolResult> {
  return organize(ctx, id, async (item, imap) => {
    await imap.setFlags(item.folder, item.uid, flags);
    await ctx.store.updateFlags(id, flags);
    return { id, ...flags };
  });
}

/**
 * IMAP で移動してから DynamoDB を更新する（REQ-031, REQ-032）。
 * id はフォルダを含む（ADR-0006）ので、移動先の id で新レコードを作り旧レコードを消す。
 * 生メッセージは同じ s3Key を参照し続ける（MCP 実行ロールは S3 に書けない）。
 */
export function moveTo(ctx: ToolContext, id: string, destination: (imap: ImapSession) => Promise<string>): Promise<CallToolResult> {
  return organize(ctx, id, async (item, imap) => {
    const folder = await destination(imap);
    const moved = await imap.move(item.folder, item.uid, folder);
    const { uidValidity } = await imap.select(moved.folder);
    const newId = deriveId({ messageId: item.messageId, folder: moved.folder, uidValidity, uid: moved.uid });
    await ctx.store.putMessage({ ...item, id: newId, folder: moved.folder, uid: moved.uid, uidValidity });
    await ctx.store.deleteMessage(item.id);
    return { id: newId, folder: moved.folder };
  });
}
