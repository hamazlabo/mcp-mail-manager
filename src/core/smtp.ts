/**
 * SmtpSender: nodemailer ラッパ + Sent APPEND（design.md 3.1 / REQ-020）。
 * SMTP 送信に成功したときだけ、同じ RFC 5322 メッセージを IMAP の Sent フォルダへ APPEND する。
 */
import type Mail from 'nodemailer/lib/mailer';
import type { ImapSession } from './imap';
import type { MailConfig } from './types';

export type SendOptions = Mail.Options & { messageId: string };

export interface SmtpSender {
  /** SMTP 送信 → Sent へ APPEND。SMTP 失敗時は APPEND せず例外。戻り値の messageId は入力と同じ */
  send(options: SendOptions, imap: ImapSession): Promise<{ messageId: string }>;
}

export type SmtpSenderFactory = (config: MailConfig) => SmtpSender;
