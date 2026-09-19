/**
 * メッセージ ID の導出（design.md 4 章）。
 * Message-ID ヘッダがあればそれを元にするため、フォルダ移動しても同じ id になる。
 */
import { createHash } from 'node:crypto';

const hex32 = (input: string) => createHash('sha256').update(input).digest('hex').slice(0, 32);

/** Message-ID ヘッダから導出。前後空白と `<>` を除いて正規化する */
export function idFromMessageId(messageId: string): string {
  return hex32(normalizeMessageId(messageId));
}

/** Message-ID が無いメッセージ用: フォルダ / UIDVALIDITY / UID から導出 */
export function idFromLocation(folder: string, uidValidity: number, uid: number): string {
  return hex32(`${folder}:${uidValidity}:${uid}`);
}

export function deriveId(input: { messageId?: string; folder: string; uidValidity: number; uid: number }): string {
  const normalized = input.messageId === undefined ? '' : normalizeMessageId(input.messageId);
  return normalized ? hex32(normalized) : idFromLocation(input.folder, input.uidValidity, input.uid);
}

function normalizeMessageId(messageId: string): string {
  return messageId.trim().replace(/^<|>$/g, '').trim();
}
