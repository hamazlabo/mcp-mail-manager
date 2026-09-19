import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** REQ-032: コードベースに EXPUNGE を発行する経路が存在しない（静的検証）。 */
const FORBIDDEN = /expunge|messageDelete|mailboxClose/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

/** `//` 行コメントと `/* *\/` ブロックコメントを除いたコードだけを残す。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('no EXPUNGE path in src/', () => {
  it('never references expunge / messageDelete / mailboxClose outside comments', () => {
    const offenders = sourceFiles('src')
      .map((file) => ({ file, code: stripComments(readFileSync(file, 'utf8')) }))
      .filter(({ code }) => FORBIDDEN.test(code))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
