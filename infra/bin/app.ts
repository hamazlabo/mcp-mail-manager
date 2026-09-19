import { App } from 'aws-cdk-lib';
import { MailMcpStack, resolveStage } from '../lib/mail-mcp-stack';

const app = new App();
new MailMcpStack(app, resolveStage(app));
