/**
 * メッセージ組立（REQ-020〜022）。純粋関数で nodemailer の Mail.Options を返す。
 * From は設定値固定。Message-ID は呼出側が newMessageId() で採番して渡す（SMTP 送信と Sent APPEND で同じ値を使う）。
 */
import { randomUUID } from 'node:crypto';
import type Mail from 'nodemailer/lib/mailer';
import type { MailConfig, ParsedMessage } from './types';

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function newMessageId(domain: string): string {
  return `<${randomUUID()}@${domain}>`;
}

/** `Name <addr>` または `addr` からアドレス部分を取り出す */
function addressOf(recipient: string): string {
  const m = recipient.match(/<([^>]*)>\s*$/);
  return (m ? m[1] : recipient).trim();
}

function assertRecipients(to: string[], cc: string[] = [], bcc: string[] = []): void {
  if (to.length === 0) throw new Error('at least one recipient (to) is required');
  for (const r of [...to, ...cc, ...bcc]) {
    if (!ADDRESS.test(addressOf(r))) throw new Error(`invalid recipient: ${r}`);
  }
}

function from(config: MailConfig): Mail.Options['from'] {
  return config.fromName ? { name: config.fromName, address: config.address } : config.address;
}

function prefixed(subject: string, prefix: string, already: RegExp): string {
  return already.test(subject) ? subject : `${prefix} ${subject}`;
}

/** アドレス部分（大文字小文字無視）で重複を除く。exclude に含まれるものも除く */
function dedupe(recipients: string[], exclude: string[] = []): string[] {
  const seen = new Set(exclude.map((r) => addressOf(r).toLowerCase()));
  return recipients.filter((r) => {
    const key = addressOf(r).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface NewMessageInput {
  config: MailConfig;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  messageId: string;
}

export function buildNew({ config, to, cc, bcc, subject, body, messageId }: NewMessageInput): Mail.Options {
  assertRecipients(to, cc, bcc);
  return {
    from: from(config),
    to,
    ...(cc?.length ? { cc } : {}),
    ...(bcc?.length ? { bcc } : {}),
    subject,
    text: body,
    messageId,
  };
}

export interface ReplyInput {
  config: MailConfig;
  original: ParsedMessage;
  body: string;
  replyAll?: boolean;
  messageId: string;
}

export function buildReply({ config, original, body, replyAll, messageId }: ReplyInput): Mail.Options {
  const h = original.headers;
  const self = [config.address];
  const fromSelf = addressOf(h.from).toLowerCase() === config.address.toLowerCase();
  // 自分が送ったメールへの返信は元の宛先へ。それ以外は元の差出人へ
  const to = dedupe(fromSelf ? h.to : replyAll ? [h.from, ...h.to] : [h.from], self);
  const cc = replyAll ? dedupe(h.cc, [...self, ...to]) : [];
  assertRecipients(to, cc);
  return {
    from: from(config),
    to,
    ...(cc.length ? { cc } : {}),
    subject: prefixed(h.subject, 'Re:', /^re:\s*/i),
    text: body,
    messageId,
    ...(h.messageId ? { inReplyTo: h.messageId, references: [...h.references, h.messageId] } : {}),
  };
}

export interface ForwardInput {
  config: MailConfig;
  original: ParsedMessage;
  to: string[];
  comment?: string;
  messageId: string;
}

export function buildForward({ config, original, to, comment, messageId }: ForwardInput): Mail.Options {
  assertRecipients(to);
  const h = original.headers;
  const lines: string[] = [];
  if (comment) lines.push(comment, '');
  lines.push('---------- Forwarded message ----------', `From: ${h.from}`);
  if (h.date) lines.push(`Date: ${h.date}`);
  lines.push(`Subject: ${h.subject}`, `To: ${h.to.join(', ')}`, '', original.text);
  if (original.attachments.length > 0) {
    // 添付は転送しない（スコープ外）。あった旨だけ本文に残す
    const list = original.attachments.map((a) => `${a.filename} (${Math.max(1, Math.round(a.size / 1024))} KB)`).join(', ');
    lines.push('', `添付ファイル ${original.attachments.length} 件は転送されません: ${list}`);
  }
  return {
    from: from(config),
    to,
    subject: prefixed(h.subject, 'Fwd:', /^fwd?:\s*/i),
    text: lines.join('\n'),
    messageId,
  };
}
