/**
 * ツール応答の整形。成功は JSON 文字列、失敗は isError（design.md 6 章）。
 * エラー文にはホスト名と種別のみを含め、パスワードは含めない（REQ-052）。
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MailConfig } from '../../core/types';

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** 例外を 1 行の文字列にする。config があればパスワードの値を伏せる */
export function describeError(err: unknown, config?: Pick<MailConfig, 'password'>): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return config?.password ? text.split(config.password).join('***') : text;
}
