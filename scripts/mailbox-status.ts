/**
 * 実機確認用: INBOX の件数・新着数・未読数を出力する（REQ-005、design.md 9 章、T-035）。
 * フォルダを開かない `STATUS INBOX (MESSAGES RECENT UNSEEN)` だけを発行し、確認作業自体がサーバの状態を変えないようにする。
 * 認証情報は出力しない（REQ-052）。
 *
 * 使い方: AWS_PROFILE=mail-manager_<stage> npx tsx scripts/mailbox-status.ts <dev|prod>
 */
import { ImapFlow } from 'imapflow';
import { loadMailConfig } from '../src/core/secrets';
import type { MailConfig } from '../src/core/types';

export async function mailboxStatus(config: MailConfig): Promise<{ messages: number; recent: number; unseen: number }> {
  // 接続設定は openImapSession と同じ（さくらはユーザ名にメールアドレス全体が必要）
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: true,
    auth: { user: config.address, pass: config.password },
    logger: false,
  });
  await client.connect();
  try {
    // imapflow は IMAP4rev2 のサーバには RECENT を問い合わせず 0 を返す。さくら（Courier）は IMAP4rev1
    const status = await client.status('INBOX', { messages: true, recent: true, unseen: true });
    // 型定義に反し、imapflow は STATUS の失敗を例外ではなく false で返す。0 件と誤読させない
    if (!status) throw new Error('STATUS INBOX failed');
    return { messages: status.messages ?? 0, recent: status.recent ?? 0, unseen: status.unseen ?? 0 };
  } finally {
    await client.logout();
  }
}

async function main(stage: string | undefined): Promise<void> {
  if (stage !== 'dev' && stage !== 'prod') {
    console.error('usage: AWS_PROFILE=mail-manager_<stage> npx tsx scripts/mailbox-status.ts <dev|prod>');
    process.exit(1);
  }
  const config = await loadMailConfig({ secretId: `mail-mcp/${stage}/mail` });
  console.log(JSON.stringify(await mailboxStatus(config)));
}

// tsx で直接実行したときだけ動く（テストからの import では動かない）
if (process.argv[1]?.endsWith('mailbox-status.ts')) {
  main(process.argv[2]).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
