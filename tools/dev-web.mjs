import { spawn } from 'node:child_process';
import { start } from '../services/api/server.mjs';
const args = process.argv.slice(2);
const requestedPort = args.indexOf('--port');
const port = Number(requestedPort >= 0 ? args[requestedPort + 1] : process.env.IMSTAGE_WEB_PORT || 4417);
const app = await start({ port: Number(process.env.IMSTAGE_API_PORT || 4419), appOrigin: process.env.IMSTAGE_APP_ORIGIN || `http://127.0.0.1:${port}`, distDir: '' });
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'inherit', env: { ...process.env, IMSTAGE_API_TARGET: `http://127.0.0.1:${app.port}` } });
let stopping = false;
async function stop(code = 0) { if (stopping) return; stopping = true; vite.kill('SIGTERM'); await app.close(); process.exit(code); }
vite.once('error', () => { void stop(1); });
vite.once('exit', code => { void stop(code || 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(); });
