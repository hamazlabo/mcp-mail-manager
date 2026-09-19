/**
 * SmtpSender: nodemailer ラッパ + Sent APPEND（design.md 3.1 / REQ-020）。
 * SMTP 送信に成功したときだけ、同じ RFC 5322 メッセージを IMAP の Sent フォルダへ APPEND する。
 */
import { createTransport, type Transporter } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import type { ImapSession } from './imap';
import type { MailConfig } from './types';

export type SendOptions = Mail.Options & { messageId: string };

export interface SmtpSender {
  /** SMTP 送信 → Sent へ APPEND。SMTP 失敗時は APPEND せず例外。戻り値の messageId は入力と同じ */
  send(options: SendOptions, imap: ImapSession): Promise<{ messageId: string }>;
}

export type SmtpSenderFactory = (config: MailConfig) => SmtpSender;

export type SmtpTransport = Pick<Transporter, 'sendMail'>;

/** phase=smtp: 未送信（APPEND もしていない）。phase=append: 送信済みだが Sent に残せなかった */
export class SendError extends Error {
  readonly phase: 'smtp' | 'append';
  constructor(phase: 'smtp' | 'append', message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'SendError';
    this.phase = phase;
  }
}

export class NodemailerSender implements SmtpSender {
  private readonly transport: SmtpTransport;

  constructor(
    private readonly config: MailConfig,
    transport?: SmtpTransport,
  ) {
    this.transport =
      transport ??
      createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure,
        auth: { user: config.address, pass: config.password },
      });
  }

  async send(options: SendOptions, imap: ImapSession): Promise<{ messageId: string }> {
    const { config } = this;
    // From は設定値固定（REQ-020）。Date を固定して SMTP 送信と Sent の内容を一致させる
    const opts: SendOptions = {
      ...options,
      from: config.fromName ? { name: config.fromName, address: config.address } : config.address,
      date: options.date ?? new Date(),
    };
    const raw = await new MailComposer(opts).compile().build();
    try {
      await this.transport.sendMail(opts);
    } catch (err) {
      throw new SendError('smtp', `SMTP send failed (${config.smtpHost}:${config.smtpPort}): ${this.describe(err)}`, err);
    }
    try {
      const { sent } = await imap.specialFolders();
      await imap.append(sent, raw, ['\\Seen'], new Date());
    } catch (err) {
      throw new SendError('append', `sent, but APPEND to Sent failed (${config.imapHost}): ${this.describe(err)}`, err);
    }
    return { messageId: options.messageId };
  }

  /** 原因のメッセージからパスワードを伏せる（REQ-052） */
  private describe(err: unknown): string {
    const text = err instanceof Error ? err.message : String(err);
    return text.split(this.config.password).join('***');
  }
}

export const createSmtpSender: SmtpSenderFactory = (config) => new NodemailerSender(config);
