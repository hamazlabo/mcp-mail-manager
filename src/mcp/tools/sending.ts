/**
 * 送信系 3 ツールの共通処理（REQ-020〜022）。
 * 組立（compose）で失敗したら送信せず isError、送信は withImap で Sent APPEND まで行う。
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseMessage } from '../../core/mime';
import type { SendOptions } from '../../core/smtp';
import type { MailConfig, ParsedMessage } from '../../core/types';
import { withImap, type ToolContext } from '../context';
import { describeError, fail, ok } from './result';

/** 設定を読んで組立 → SMTP 送信 → Sent APPEND。結果は `{ messageId }` */
export async function sendComposed(ctx: ToolContext, build: (config: MailConfig) => SendOptions): Promise<CallToolResult> {
  const config = await ctx.loadConfig();
  let options: SendOptions;
  try {
    options = build(config);
  } catch (err) {
    return fail(describeError(err));
  }
  try {
    return ok(await withImap(ctx, (imap) => ctx.createSmtp(config).send(options, imap)));
  } catch (err) {
    return fail(describeError(err, config));
  }
}

/** 返信・転送の元メッセージを S3 から読んで解析する。無ければ isError */
export async function loadOriginal(ctx: ToolContext, id: string): Promise<ParsedMessage | CallToolResult> {
  const item = await ctx.store.getMessage(id);
  const raw = item && (await ctx.store.getRaw(id));
  if (!raw) return fail(`message not found: ${id}`);
  return parseMessage(raw);
}

export function isToolResult(value: ParsedMessage | CallToolResult): value is CallToolResult {
  return 'content' in value;
}
