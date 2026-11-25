// UDP LAN transport. One datagram = one frame. Discovery: a small beacon ("tangent1" + 8 byte
// instance id) goes to the broadcast address and to any static peers every discoveryIntervalMs;
// any node that hears a beacon or a frame learns the sender as a peer. send(bytes) with no peer
// goes to every known peer (unicast); beacons are what use broadcast.
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';

const BEACON = Buffer.from('tangent1'); // 8 bytes

export function createUdpTransport({
  port = 0, bindAddress = '0.0.0.0', broadcastAddress = '255.255.255.255', broadcastPort = null,
  peers = [], discoveryIntervalMs = 2000, peerTtlMs = 60_000, broadcast = true, log = () => {},
} = {}) {
  const instance = randomBytes(8);
  const known = new Map(); // id -> { address, port, lastSeen }
  let sock = null, timer = null, onFrame = null, running = false;
  const key = (a, p) => `udp:${a}:${p}`;
  for (const p of peers) known.set(key(p.host, p.port), { address: p.host, port: p.port, lastSeen: Date.now(), static: true });

  function sendTo(buf, address, p) { try { sock.send(buf, p, address); } catch (e) { log('udp: send ' + e.message); } }
  function beacon() {
    const b = Buffer.concat([BEACON, instance]);
    if (broadcast) sendTo(b, broadcastAddress, broadcastPort ?? t.port);
    for (const k of known.values()) sendTo(b, k.address, k.port);
    const now = Date.now();
    for (const [id, k] of known) if (!k.static && now - k.lastSeen > peerTtlMs) known.delete(id);
  }

  const t = {
    name: 'udp',
    port: null,
    async start(cb) {
      onFrame = cb; running = true;
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', (e) => log('udp: ' + e.message));
      sock.on('message', (msg, rinfo) => {
        if (msg.length === 16 && msg.subarray(0, 8).equals(BEACON)) {
          if (msg.subarray(8).equals(instance)) return; // our own beacon
          const id = key(rinfo.address, rinfo.port);
          const k = known.get(id);
          if (k) k.lastSeen = Date.now(); else known.set(id, { address: rinfo.address, port: rinfo.port, lastSeen: Date.now() });
          return;
        }
        if (rinfo.port === t.port && selfAddress(rinfo.address)) return; // our own broadcast echo
        const id = key(rinfo.address, rinfo.port);
        const k = known.get(id);
        if (k) k.lastSeen = Date.now(); else known.set(id, { address: rinfo.address, port: rinfo.port, lastSeen: Date.now() });
        try { onFrame?.(new Uint8Array(msg), { id }); } catch (e) { log('udp: handler ' + e.message); }
      });
      await new Promise((res, rej) => { sock.once('error', rej); sock.bind(port, bindAddress, () => { sock.off('error', rej); res(); }); });
      t.port = sock.address().port;
      if (broadcast) { try { sock.setBroadcast(true); } catch (e) { log('udp: broadcast unavailable ' + e.message); } }
      beacon();
      timer = setInterval(beacon, discoveryIntervalMs); timer.unref?.();
    },
    send(bytes, peer) {
      if (!running || !sock) return;
      const buf = Buffer.from(bytes);
      if (peer) { const k = known.get(peer.id); if (k) sendTo(buf, k.address, k.port); return; }
      for (const k of known.values()) sendTo(buf, k.address, k.port);
    },
    async stop() {
      running = false; clearInterval(timer);
      if (sock) await new Promise((r) => sock.close(() => r()));
      sock = null;
    },
    peers() { return [...known.keys()]; },
  };
  function selfAddress(a) { return a === bindAddress || a === '127.0.0.1' && (bindAddress === '0.0.0.0' || bindAddress === '127.0.0.1'); }
  return t;
}
