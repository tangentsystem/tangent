// Host side of the docker egress path: a unix socket per machine whose every
// connection is piped to the egress SOCKS proxy (host:port).
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function createEgressBridge({ dir, socksHost, socksPort, maxConnections = 64 }) {
  await fs.mkdir(dir, { recursive: true, mode: 0o755 });
  await fs.chmod(dir, 0o755);
  const sockPath = path.join(dir, 'egress.sock');
  await fs.rm(sockPath, { force: true });
  const conns = new Set();
  const server = net.createServer((c) => {
    if (conns.size >= maxConnections) { c.destroy(); return; }
    const up = net.connect(socksPort, socksHost);
    conns.add(c);
    const end = () => { c.destroy(); up.destroy(); conns.delete(c); };
    c.on('error', end); up.on('error', end); c.on('close', end); up.on('close', end);
    c.pipe(up); up.pipe(c);
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(sockPath, res); });
  await fs.chmod(sockPath, 0o666);
  return {
    dir, sockPath,
    async close() {
      for (const c of conns) c.destroy();
      await new Promise((r) => server.close(() => r()));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
