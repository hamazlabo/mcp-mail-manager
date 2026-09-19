// esbuild: MCP コンテナ用の単一ファイルバンドル。docker/Dockerfile が dist/mcp/main.js を参照する。
import { build } from 'esbuild';
import { existsSync } from 'node:fs';

const entry = 'src/mcp/main.ts';
if (!existsSync(entry)) {
  // T-019 以前は MCP エントリが無いので何もしない（CI の build ステップを通すため）
  console.log(`build: ${entry} not present yet, nothing to bundle`);
  process.exit(0);
}

await build({
  entryPoints: [entry],
  outfile: 'dist/mcp/main.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'info',
});
