// Runtime configuration for the IMStage MCP server.
//
// Security posture:
//   - always binds loopback (127.0.0.1); there is no public bind option
//   - requires IMSTAGE_MCP_TOKEN for HTTP Bearer auth
//   - the only unauthenticated mode is IMSTAGE_MCP_PRIVATE_TUNNEL=1, intended
//     for an authenticated private outbound tunnel that terminates auth before
//     reaching this loopback port. It is never a public unauthenticated mode.
//   - storage is isolated to IMSTAGE_MCP_DATA_DIR; the real API database is
//     never opened.

import path from 'node:path';
import { DEFAULT_MCP_PORT, HEALTH_PATH, MCP_PATH, TOKEN_MAX_LENGTH, TOKEN_MIN_LENGTH } from './limits.mjs';

const LOOPBACK_HOST = '127.0.0.1';

function parsePort(value) {
  const raw = value === undefined || value === null || value === '' ? DEFAULT_MCP_PORT : value;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`IMSTAGE_MCP_PORT 必须是 0-65535 的整数，当前值：${String(raw)}`);
  }
  return port;
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ host: string, port: number, path: string, dataDir: string, token: string|null, privateTunnel: boolean, allowedHosts: string[] }}
 */
export function resolveMcpConfig(env = process.env) {
  const dataDirRaw = String(env.IMSTAGE_MCP_DATA_DIR ?? '').trim();
  if (dataDirRaw === '') {
    throw new Error(
      '必须设置 IMSTAGE_MCP_DATA_DIR 指向隔离的持久化目录（例如 ~/.local/state/imstage-mcp）；MCP 不会读写产品数据库。',
    );
  }
  const dataDir = path.resolve(dataDirRaw);

  const privateTunnel = isTruthy(env.IMSTAGE_MCP_PRIVATE_TUNNEL);
  const tokenRaw = String(env.IMSTAGE_MCP_TOKEN ?? '').trim();
  let token = null;
  if (tokenRaw !== '') {
    if (tokenRaw.length < TOKEN_MIN_LENGTH || tokenRaw.length > TOKEN_MAX_LENGTH) {
      throw new Error(`IMSTAGE_MCP_TOKEN 长度必须在 ${TOKEN_MIN_LENGTH}-${TOKEN_MAX_LENGTH} 之间`);
    }
    token = tokenRaw;
  } else if (!privateTunnel) {
    throw new Error(
      '缺少 IMSTAGE_MCP_TOKEN：所有 /mcp 请求都要求 Bearer 认证。仅当使用已认证的私有出站隧道时才可设置 IMSTAGE_MCP_PRIVATE_TUNNEL=1。',
    );
  }

  const allowedHosts = String(env.IMSTAGE_MCP_ALLOWED_HOSTS ?? '127.0.0.1,localhost,::1')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return {
    host: LOOPBACK_HOST,
    port: parsePort(env.IMSTAGE_MCP_PORT),
    path: MCP_PATH,
    healthPath: HEALTH_PATH,
    dataDir,
    token,
    privateTunnel,
    allowedHosts,
  };
}

export { LOOPBACK_HOST };
