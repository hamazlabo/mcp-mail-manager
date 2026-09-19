/**
 * コンテナのエントリ。0.0.0.0:8000（PORT で上書き可）で待ち受ける。import されない前提。
 * 依存の実物（DynamoDB / S3 / Secrets Manager / IMAP / SMTP / Scheduler）を環境変数から組み立てる。
 */
import { openImapSession } from '../core/imap';
import { EventBridgeSendScheduler } from '../core/scheduler';
import { loadMailConfig } from '../core/secrets';
import { createSmtpSender } from '../core/smtp';
import { MailStore } from '../core/store';
import type { ToolContext } from './context';
import { createHttpServer } from './server';
import { registerAllTools } from './tools/index';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`environment variable ${name} is required`);
  return value;
}

const ctx: ToolContext = {
  store: new MailStore({ tableName: env('TABLE_NAME'), bucketName: env('BUCKET_NAME') }),
  loadConfig: () => loadMailConfig({ secretId: env('MAIL_SECRET_ARN') }),
  openImap: openImapSession,
  createSmtp: createSmtpSender,
  scheduler: new EventBridgeSendScheduler({
    groupName: env('SCHEDULE_GROUP'),
    targetArn: env('SCHEDULED_SEND_FUNCTION_ARN'),
    roleArn: env('SCHEDULER_ROLE_ARN'),
  }),
  now: () => new Date(),
};

const port = Number(process.env.PORT ?? 8000);
const host = '0.0.0.0';
const server = createHttpServer((mcp) => registerAllTools(mcp, ctx));

server.listen(port, host, () => {
  console.log(JSON.stringify({ level: 'info', event: 'mcp.listening', host, port, stage: process.env.STAGE }));
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
