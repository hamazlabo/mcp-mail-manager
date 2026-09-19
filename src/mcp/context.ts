/**
 * ツール実装に渡す依存の束。main.ts が実物を、テストがフェイクを組み立てる。
 */
import type { ImapSession, ImapSessionFactory } from '../core/imap';
import type { SendScheduler } from '../core/scheduler';
import type { SmtpSenderFactory } from '../core/smtp';
import type { MailStore } from '../core/store';
import type { MailConfig } from '../core/types';

export interface ToolContext {
  store: MailStore;
  loadConfig: () => Promise<MailConfig>;
  openImap: ImapSessionFactory;
  createSmtp: SmtpSenderFactory;
  scheduler: SendScheduler;
  /** 現在時刻（テストで固定する） */
  now: () => Date;
}

/** IMAP セッションを開いて fn を実行し、必ず閉じる */
export async function withImap<T>(ctx: ToolContext, fn: (imap: ImapSession, config: MailConfig) => Promise<T>): Promise<T> {
  const config = await ctx.loadConfig();
  const imap = await ctx.openImap(config);
  try {
    return await fn(imap, config);
  } finally {
    await imap.close();
  }
}
