// App settings. Everything here has a default; tests and power users override with env.
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_COORDINATOR = 'https://tangentsystems.net';
export const CONTROL_PORT = 47611;
export const SOCKS_PORT = 47612;
export const MCP_PORT = 47613;

function port(v, d) {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < 65536 ? n : d;
}

export function resolveConfig({ env = process.env, userData = null } = {}) {
  const coordinator = String(env.TANGENT_COORDINATOR || DEFAULT_COORDINATOR).replace(/\/+$/, '');
  const dataDir = path.resolve(env.TANGENT_APP_DATA || userData || path.join(os.homedir(), '.tangent', 'app'));
  return {
    coordinator,
    dataDir,
    controlPort: port(env.TANGENT_CONTROL_PORT, CONTROL_PORT),
    socksPort: port(env.TANGENT_SOCKS_PORT, SOCKS_PORT),
    mcpPort: port(env.TANGENT_MCP_PORT, MCP_PORT),
  };
}
