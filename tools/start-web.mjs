import path from 'node:path';
import { start } from '../services/api/server.mjs';
const port = Number(process.env.IMSTAGE_WEB_PORT || 4417);
const app = await start({ port, appOrigin: process.env.IMSTAGE_APP_ORIGIN || `http://127.0.0.1:${port}`, distDir: path.resolve('dist') });
if (!app.config.distRoot) { await app.close(); console.error('Run npm run build before npm start.'); process.exit(1); }
console.log(`IMStage Web ready: http://127.0.0.1:${app.port}/#/workspace`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
