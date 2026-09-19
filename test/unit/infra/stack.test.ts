import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { MailMcpStack, resolveStage } from '../../../infra/lib/mail-mcp-stack';

function synth(stage?: string) {
  const app = new App({ context: stage === undefined ? {} : { stage } });
  return new MailMcpStack(app, resolveStage(app));
}

describe('MailMcpStack stage context', () => {
  it('names the stack MailMcp-<stage> so dev and prod differ', () => {
    expect(synth('dev').stackName).toBe('MailMcp-dev');
    expect(synth('prod').stackName).toBe('MailMcp-prod');
  });

  it('pins the region to ap-northeast-1', () => {
    expect(synth('dev').region).toBe('ap-northeast-1');
  });

  it('fails when stage is missing or unknown', () => {
    expect(() => synth()).toThrow(/stage/);
    expect(() => synth('staging')).toThrow(/stage/);
  });

  it('synthesizes a template', () => {
    expect(() => Template.fromStack(synth('dev'))).not.toThrow();
  });
});
