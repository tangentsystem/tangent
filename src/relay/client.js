// Client: picks paths from the directory, keeps a small pool of circuits, and exposes a
// local SOCKS5 proxy. Every stream opened through SOCKS rides a circuit; when a circuit
// dies its streams end and the next request builds a fresh circuit on a new path.
import net from 'node:net';
import { randomInt } from 'node:crypto';
import { checkDescriptor } from '../core/index.js';
import { buildCircuit, CircuitError } from './circuit.js';
import { readSocksRequest, replyCell, repForReason, REP } from './socks.js';
import { MAX_HOPS } from './cells.js';
import { normLog } from './log.js';

function pick(list) { return list[randomInt(0, list.length)]; }

export function selectPath(directory, { hops = 3, exclude = new Set() } = {}) {
  if (hops < 1 || hops > MAX_HOPS) throw new Error(`path: hops must be 1..${MAX_HOPS}`);
  const usable = directory.filter((d) => !exclude.has(d.id));
  const exits = usable.filter((d) => d.roles.includes('exit'));
  if (!exits.length) throw new Error('path: no exit available');
  const exit = pick(exits);
  const path = [exit];
  const used = new Set([exit.id]);
  for (let i = hops - 2; i >= 0; i--) {
    const relays = usable.filter((d) => d.roles.includes('relay') && !used.has(d.id));
    // keep exits for the exit position when there are enough plain relays
    const plain = relays.filter((d) => !d.roles.includes('exit'));
    const pool = plain.length ? plain : relays;
    if (!pool.length) throw new Error('path: not enough relays');
    const n = pick(pool);
    used.add(n.id);
    path.unshift(n);
  }
  return path;
}

export function usableDescriptors(list, { maxAgeMs = 6 * 3600_000, now = Date.now() } = {}) {
  const out = [];
  const seen = new Set();
  for (const d of list || []) {
    if (!d || seen.has(d.id)) continue;
    if (!checkDescriptor(d, { maxAgeMs, now }).ok) continue;
    if (!d.host || !d.port || !d.kx) continue;
    if (!d.roles.includes('relay') && !d.roles.includes('exit')) continue;
    seen.add(d.id);
    out.push(d);
  }
  return out;
}

export function createClient(opts = {}) {
  const {
    hops = 3, credit = null, socksHost = '127.0.0.1', descriptorMaxAgeMs = 6 * 3600_000,
    maxStreamsPerCircuit = 32, maxCircuitAgeMs = 10 * 60_000, buildTimeoutMs = 15_000, buildAttempts = 4,
    failedNodeTtlMs = 5 * 60_000, maxCircuits = 8, streamTimeoutMs = 20_000,
  } = opts;
  const log = normLog(opts.log);
  let dir = usableDescriptors(opts.directory, { maxAgeMs: descriptorMaxAgeMs });
  let listenPort = Number(opts.socksPort || 0);
  let server = null;
  const pool = new Set();
  const failed = new Map(); // nodeId -> until
  const sockets = new Set();
  let building = null;
  let stopped = false;

  function markFailed(id) { if (id) failed.set(id, Date.now() + failedNodeTtlMs); }
  function excluded() {
    const now = Date.now();
    for (const [id, until] of failed) if (until < now) failed.delete(id);
    return new Set(failed.keys());
  }

  async function build() {
    let lastErr = null;
    for (let attempt = 0; attempt < buildAttempts; attempt++) {
      let path;
      try { path = selectPath(dir, { hops, exclude: excluded() }); } catch (e) {
        lastErr = e;
        break;
      }
      try {
        const c = await buildCircuit({ path, credit, log, timeoutMs: buildTimeoutMs, maxStreams: maxStreamsPerCircuit });
        c.on('close', ({ failedNode }) => { pool.delete(c); if (failedNode) markFailed(failedNode); });
        if (stopped) { c.close('client stopped'); throw new Error('client stopped'); }
        pool.add(c);
        while (pool.size > maxCircuits) {
          const idle = [...pool].find((x) => x.streamCount() === 0 && x !== c);
          if (!idle) break;
          idle.close('pool trim');
        }
        return c;
      } catch (e) {
        lastErr = e;
        if (e instanceof CircuitError && e.failedNode) markFailed(e.failedNode);
        log.debug('client: circuit build failed', { err: e.message });
      }
    }
    throw lastErr || new Error('circuit build failed');
  }

  // After credit moves a node to a fresh account, new streams go to a new circuit paid by it;
  // streams already open finish on the circuit they started on.
  function paidByCurrent(c) {
    if (!credit || typeof credit.isCurrent !== 'function' || typeof c.payers !== 'function') return true;
    return c.payers().every((p) => credit.isCurrent(p.node, p.account));
  }

  async function getCircuit() {
    const now = Date.now();
    for (const c of pool) {
      if (c.open && !c.closed && c.streamCount() < maxStreamsPerCircuit && now - c.createdAt < maxCircuitAgeMs && paidByCurrent(c)) return c;
    }
    if (!building) building = build().finally(() => { building = null; });
    return building;
  }

  async function openStream(host, port) {
    let lastErr;
    for (let i = 0; i < 2; i++) {
      const c = await getCircuit();
      try { return await c.openStream(host, port, { timeoutMs: streamTimeoutMs }); } catch (e) {
        lastErr = e;
        if (e.reason) throw e; // the exit answered: do not retry
      }
    }
    throw lastErr;
  }

  async function onSocks(sock) {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let req;
    try { req = await readSocksRequest(sock); } catch { return; }
    let stream;
    try { stream = await openStream(req.host, req.port); } catch (e) {
      if (!sock.destroyed) sock.end(replyCell(e.reason ? repForReason(e.reason) : REP.GENERAL));
      return;
    }
    if (sock.destroyed) { stream.destroy(); return; }
    sock.write(replyCell(REP.OK));
    if (req.rest.length) stream.write(req.rest);
    sock.pipe(stream);
    stream.pipe(sock);
    stream.on('error', () => sock.destroy());
    stream.on('close', () => {
      if (sock.destroyed) return;
      if (stream.readableEnded && sock.writableEnded) return; // clean end; socket closes by itself
      sock.destroy();
    });
    sock.on('close', () => { if (!stream.destroyed) stream.destroy(); });
  }

  return {
    get socksPort() { return listenPort; },
    start() {
      stopped = false;
      return new Promise((resolve, reject) => {
        server = net.createServer(onSocks);
        server.once('error', reject);
        server.listen(listenPort, socksHost, () => {
          listenPort = server.address().port;
          log.info('client: socks proxy listening', { port: listenPort });
          resolve({ socksPort: listenPort });
        });
      });
    },
    stop() {
      stopped = true;
      for (const c of [...pool]) c.close('client stopped');
      for (const s of sockets) s.destroy();
      return new Promise((r) => { if (!server) return r(); server.close(() => r()); server = null; });
    },
    circuits() { return [...pool].map((c) => c.info()); },
    setDirectory(list) { dir = usableDescriptors(list, { maxAgeMs: descriptorMaxAgeMs }); return dir.length; },
    failedNodes() { return [...excluded()]; },
    openStream,
    // direct access for callers that drive circuits themselves (compute egress, tests)
    getCircuit,
  };
}
