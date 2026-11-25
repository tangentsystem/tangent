// TCP peer link. Each frame is sent as [len u16 BE][frame]. Listens for inbound links (when
// `port` is given, 0 picks a free port) and dials the configured peers, redialling after a drop.
// send(bytes) with no peer goes to every open link.
import net from 'node:net';

const MAX_FRAME = 4096;

export function createTcpTransport({ host = '0.0.0.0', port = null, peers = [], reconnectMs = 1000, log = () => {} } = {}) {
  const sockets = new Map(); // peerId -> socket
  let server = null, onFrame = null, running = false;
  const dialTimers = new Set();
  const t = {
    name: 'tcp',
    port: null,
    async start(cb) {
      onFrame = cb; running = true;
      if (port !== null) {
        server = net.createServer((sock) => attach(sock, 'in'));
        await new Promise((res, rej) => { server.once('error', rej); server.listen(port, host, () => { server.off('error', rej); res(); }); });
        t.port = server.address().port;
      }
      for (const p of peers) dial(p);
    },
    send(bytes, peer) {
      if (!running) return;
      if (bytes.length > MAX_FRAME) throw new Error('tcp: frame too large');
      const hdr = Buffer.alloc(2); hdr.writeUInt16BE(bytes.length);
      const buf = Buffer.concat([hdr, Buffer.from(bytes)]);
      const targets = peer ? [sockets.get(peer.id)].filter(Boolean) : [...sockets.values()];
      for (const s of targets) if (!s.destroyed) s.write(buf);
    },
    async stop() {
      running = false;
      for (const d of dialTimers) clearTimeout(d);
      dialTimers.clear();
      for (const s of sockets.values()) s.destroy();
      sockets.clear();
      if (server) await new Promise((r) => server.close(() => r()));
      server = null;
    },
    links() { return [...sockets.keys()]; },
  };

  function dial(p) {
    if (!running) return;
    const sock = net.connect({ host: p.host, port: p.port });
    sock.once('connect', () => attach(sock, 'out', p));
    sock.once('error', () => {});
    sock.once('close', () => {
      if (!running) return;
      const tm = setTimeout(() => { dialTimers.delete(tm); dial(p); }, reconnectMs);
      tm.unref?.(); dialTimers.add(tm);
    });
  }

  function attach(sock, dir, dialed) {
    sock.setNoDelay(true);
    const id = 'tcp:' + (dialed ? `${dialed.host}:${dialed.port}` : `${sock.remoteAddress}:${sock.remotePort}`) + ':' + dir;
    sockets.set(id, sock);
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (len > MAX_FRAME) { log('tcp: oversize frame, dropping link'); sock.destroy(); return; }
        if (buf.length < 2 + len) break;
        const frame = new Uint8Array(buf.subarray(2, 2 + len));
        buf = buf.subarray(2 + len);
        try { onFrame?.(frame, { id }); } catch (e) { log('tcp: handler error ' + e.message); }
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { if (sockets.get(id) === sock) sockets.delete(id); });
  }
  return t;
}
