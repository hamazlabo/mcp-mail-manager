import { existsSync, readFileSync } from 'node:fs';

export type StackOutputs = Record<string, string>;

/**
 * `cdk deploy --outputs-file` の JSON から、STAGE に対応するスタック `MailMcp-<stage>` の出力を返す。
 * 環境変数は注入可能（テスト用）。
 */
export function loadOutputs(env: NodeJS.ProcessEnv = process.env): StackOutputs {
  const stage = env.STAGE;
  if (!stage) throw new Error('STAGE is not set (expected dev or prod)');
  const file = env.CDK_OUTPUTS_FILE;
  if (!file) throw new Error('CDK_OUTPUTS_FILE is not set (path to the JSON written by cdk deploy --outputs-file)');
  if (!existsSync(file)) throw new Error(`CDK outputs file not found: ${file}`);

  const stackName = `MailMcp-${stage}`;
  const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, StackOutputs>;
  const outputs = all[stackName];
  if (!outputs) throw new Error(`stack ${stackName} not found in ${file} (stacks: ${Object.keys(all).join(', ')})`);
  return outputs;
}
