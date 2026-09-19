/**
 * MIME 解析（REQ-011）: 生メッセージからヘッダ・テキスト本文・添付メタ情報を取り出す。
 * mailparser は text/plain が無いとき text/html をテキスト化して `text` に入れる。添付の本体は返さない。
 */
import { convert } from 'html-to-text';
import { simpleParser, type AddressObject } from 'mailparser';
import type { ParsedMessage } from './types';

function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  const objects = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return objects.flatMap((o) => o.value).flatMap((a) => {
    if (a.group) return a.group.map(format);
    return [format(a)];
  });
}

function format(a: { name?: string; address?: string }): string {
  const address = a.address ?? '';
  return a.name ? `${a.name} <${address}>` : address;
}

export async function parseMessage(raw: Buffer): Promise<ParsedMessage> {
  const mail = await simpleParser(raw);
  const references = mail.references === undefined ? [] : Array.isArray(mail.references) ? mail.references : [mail.references];
  return {
    headers: {
      from: addresses(mail.from)[0] ?? '',
      to: addresses(mail.to),
      cc: addresses(mail.cc),
      date: mail.date?.toISOString(),
      subject: mail.subject ?? '',
      messageId: mail.messageId,
      inReplyTo: mail.inReplyTo,
      references,
    },
    text: mail.text?.trim() ? mail.text : htmlToText(mail.html),
    attachments: mail.attachments.map((a) => ({
      filename: a.filename ?? 'attachment',
      contentType: a.contentType,
      size: a.size,
    })),
  };
}

/** text/plain が無く mailparser も text を作らなかった場合の保険（タグ無しの text/html など） */
function htmlToText(html: string | false | undefined): string {
  if (!html) return '';
  return convert(String(html), {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
    ],
  });
}
