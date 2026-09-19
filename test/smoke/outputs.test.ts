import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOutputs } from './outputs';

function outputsFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdk-outputs-'));
  const file = join(dir, 'cdk-outputs.json');
  writeFileSync(file, JSON.stringify(content));
  return file;
}

describe('loadOutputs', () => {
  it('fails clearly when CDK_OUTPUTS_FILE is not set', () => {
    expect(() => loadOutputs({ STAGE: 'dev' })).toThrow(/CDK_OUTPUTS_FILE/);
  });

  it('fails clearly when the outputs file does not exist', () => {
    expect(() => loadOutputs({ STAGE: 'dev', CDK_OUTPUTS_FILE: '/nonexistent/cdk-outputs.json' })).toThrow(
      /\/nonexistent\/cdk-outputs\.json/,
    );
  });

  it('returns the outputs of stack MailMcp-<stage>', () => {
    const file = outputsFile({
      'MailMcp-dev': { McpUrl: 'https://example.cloudfront.net/mcp', UserPoolId: 'ap-northeast-1_x' },
      'MailMcp-prod': { McpUrl: 'https://prod.cloudfront.net/mcp' },
    });
    expect(loadOutputs({ STAGE: 'dev', CDK_OUTPUTS_FILE: file })).toEqual({
      McpUrl: 'https://example.cloudfront.net/mcp',
      UserPoolId: 'ap-northeast-1_x',
    });
    expect(loadOutputs({ STAGE: 'prod', CDK_OUTPUTS_FILE: file }).McpUrl).toBe('https://prod.cloudfront.net/mcp');
  });

  it('fails when STAGE is missing or the stack is not in the file', () => {
    const file = outputsFile({ 'MailMcp-dev': {} });
    expect(() => loadOutputs({ CDK_OUTPUTS_FILE: file })).toThrow(/STAGE/);
    expect(() => loadOutputs({ STAGE: 'prod', CDK_OUTPUTS_FILE: file })).toThrow(/MailMcp-prod/);
  });
});
