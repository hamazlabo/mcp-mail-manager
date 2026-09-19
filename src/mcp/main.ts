/** コンテナのエントリ。0.0.0.0:8000（PORT で上書き可）で待ち受ける。import されない前提。 */
import { createHttpServer } from './server';

const port = Number(process.env.PORT ?? 8000);
const host = '0.0.0.0';
const server = createHttpServer();

server.listen(port, host, () => {
  console.log(JSON.stringify({ level: 'info', event: 'mcp.listening', host, port }));
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
