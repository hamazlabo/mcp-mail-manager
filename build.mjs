// esbuild: MCP コンテナ用の単一ファイルバンドル。docker/Dockerfile が dist/mcp/main.js を参照する。
import { build } from 'esbuild';

const entry = 'src/mcp/main.ts';

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
