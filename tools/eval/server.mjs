import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST, PORT } from './src/constants.mjs';
import { PACKAGE_DIR } from './src/util.mjs';
import { Store, defaultDataDir } from './src/store.mjs';
import { createApp } from './src/api.mjs';

export function createEvalServer({ dataDir, publicDir, host = HOST, port = PORT } = {}) {
  const store = new Store({ dataDir: dataDir ?? defaultDataDir() });
  let actualPort = port;
  const app = createApp({
    store,
    publicDir: publicDir ?? path.join(PACKAGE_DIR, 'public'),
    host,
    getPort: () => actualPort,
  });
  const server = http.createServer((req, res) => {
    app.handle(req, res);
  });
  server.on('listening', () => {
    const address = server.address();
    if (address && typeof address === 'object') actualPort = address.port;
  });
  server.store = store;
  return server;
}

export function startServer({ dataDir, host = HOST, port = PORT } = {}) {
  const server = createEvalServer({ dataDir, host, port });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, async () => {
      await server.store.init();
      if (server.store.loadError) {
        // Surface the corruption but keep serving the UI so the user can act.
        console.error(`[imstage-eval] ${server.store.loadError.message}`);
      }
      const address = server.address();
      console.log(`IMStage 标注实验室已启动: http://${host}:${address.port}`);
      console.log(`数据目录: ${server.store.dataDir}`);
      resolve(server);
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().catch((err) => {
    console.error(`[imstage-eval] 启动失败: ${err.message}`);
    process.exitCode = 1;
  });
}
