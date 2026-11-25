// Runs inside the egress sidecar container (network: none, loopback only).
// The machine container shares this network namespace, so its only way out is
// 127.0.0.1:1080, which this forwards over a mounted unix socket to the node,
// which pipes it to the configured egress SOCKS proxy. No other route exists.
import net from 'node:net';

const SOCK = process.env.EGRESS_SOCK || '/egress/egress.sock';
const PORT = Number(process.env.EGRESS_PORT || 1080);

net.createServer((c) => {
  const u = net.connect(SOCK);
  const end = () => { c.destroy(); u.destroy(); };
  c.on('error', end); u.on('error', end); c.on('close', end); u.on('close', end);
  c.pipe(u); u.pipe(c);
}).listen(PORT, '127.0.0.1');
