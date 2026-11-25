// In memory loopback hub for tests. Endpoints only reach the endpoints they are linked to, so a
// test can force a line topology (A - B - C - D). Configurable loss, duplication, delay and
// reordering, with a seeded random source so runs are repeatable. Enforces an MTU so tests
// prove frames really fit radio sized links.
export function createLoopbackHub({ loss = 0, duplicate = 0, delayMs = [0, 0], reorder = 0, mtu = 200, seed = 1 } = {}) {
  let s = seed >>> 0 || 1;
  const rand = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
  const endpoints = new Map(); // name -> { onFrame, running }
  const links = new Map();     // name -> Set(name)
  const stats = { sent: 0, delivered: 0, lost: 0, duplicated: 0, oversize: 0 };
  const cfg = { loss, duplicate, delayMs, reorder };
  const timers = new Set();

  function deliver(from, to, bytes) {
    const ep = endpoints.get(to);
    if (!ep || !ep.running || !ep.onFrame) return;
    stats.sent++;
    if (rand() < cfg.loss) { stats.lost++; return; }
    const copies = rand() < cfg.duplicate ? 2 : 1;
    if (copies === 2) stats.duplicated++;
    for (let c = 0; c < copies; c++) {
      let d = cfg.delayMs[0] + rand() * (cfg.delayMs[1] - cfg.delayMs[0]);
      if (rand() < cfg.reorder) d += 5 + rand() * 30; // push this frame behind later ones
      const copy = Uint8Array.from(bytes);
      const t = setTimeout(() => {
        timers.delete(t);
        const e = endpoints.get(to);
        if (e && e.running && e.onFrame) { stats.delivered++; e.onFrame(copy, { id: 'loop:' + from }); }
      }, d);
      timers.add(t);
    }
  }

  const hub = {
    stats,
    set(opts) { Object.assign(cfg, opts); },
    link(a, b) {
      if (!links.has(a)) links.set(a, new Set());
      if (!links.has(b)) links.set(b, new Set());
      links.get(a).add(b); links.get(b).add(a);
    },
    unlink(a, b) { links.get(a)?.delete(b); links.get(b)?.delete(a); },
    // Full mesh helper
    linkAll(names) { for (const a of names) for (const b of names) if (a !== b) hub.link(a, b); },
    endpoint(name) {
      if (!links.has(name)) links.set(name, new Set());
      const ep = { onFrame: null, running: false };
      endpoints.set(name, ep);
      return {
        name: 'loop',
        start(onFrame) { ep.onFrame = onFrame; ep.running = true; },
        send(bytes, peer) {
          if (!ep.running) return;
          if (bytes.length > mtu) { stats.oversize++; throw new Error('loopback: frame larger than mtu ' + mtu); }
          const targets = peer ? [String(peer.id).replace(/^loop:/, '')] : [...(links.get(name) || [])];
          for (const t of targets) if (links.get(name)?.has(t)) deliver(name, t, bytes);
        },
        stop() { ep.running = false; },
      };
    },
    close() { for (const t of timers) clearTimeout(t); timers.clear(); },
  };
  return hub;
}
