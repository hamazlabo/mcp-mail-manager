/**
 * メッセージ ID の導出（design.md 4 章、ADR-0006）。
 * Message-ID ヘッダがあれば「Message-ID + フォルダ」から導出する。同じ Message-ID が複数フォルダにある
 * （自分宛に送ったメールの INBOX コピーと Sent コピー等）場合もフォルダごとに 1 レコードになる。
 * フォルダ移動は「旧レコード削除 + 新レコード作成」で扱う。
 */
import { createHash } from 'node:crypto';

const hex32 = (input: string) => createHash('sha256').update(input).digest('hex').slice(0, 32);

/** Message-ID ヘッダとフォルダから導出。Message-ID は前後空白と `<>` を除いて正規化する */
export function idFromMessageId(messageId: string, folder: string): string {
  return hex32(`${normalizeMessageId(messageId)}:${folder}`);
}

/** Message-ID が無いメッセージ用: フォルダ / UIDVALIDITY / UID から導出 */
export function idFromLocation(folder: string, uidValidity: number, uid: number): string {
  return hex32(`${folder}:${uidValidity}:${uid}`);
}

export function deriveId(input: { messageId?: string; folder: string; uidValidity: number; uid: number }): string {
  const normalized = input.messageId === undefined ? '' : normalizeMessageId(input.messageId);
  return normalized ? idFromMessageId(normalized, input.folder) : idFromLocation(input.folder, input.uidValidity, input.uid);
}

function normalizeMessageId(messageId: string): string {
  return messageId.trim().replace(/^<|>$/g, '').trim();
}
