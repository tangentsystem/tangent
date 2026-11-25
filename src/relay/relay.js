// Relay: one hop of a circuit. Every node runs this. Exit nodes (exit: true) are the only
// ones that open outbound TCP to the open internet, and they refuse private targets.
//
// A relay sees: the previous hop's address, the next hop's address (when it extends),
// fixed size cells, and ciphertext. It never sees the payload of other hops, and a relay
// that is not the exit never sees the destination.
import net from 'node:net';
import { randomBytes, randomInt } from 'node:crypto';
import { createMeter, checkVoucher } from '../core/index.js';
import {
  CELL_SIZE, CMD, R, linkCell, destroyCell, DESTROY_REASON, cellReader, packMsg, unpackMsg,
  jsonData, parseJson, CIRC_WINDOW,
} from './cells.js';
import { serverHandshake, peelForward, addBackward, originBackward, HS_TYPE, HS_REPLY_LEN } from './crypto.js';
import { createEdge } from './edge.js';
import { resolveTarget, validHost, validPort } from './addr.js';
import { normLog } from './log.js';

const MAX_QUEUE = CIRC_WINDOW + 256;          // cells a stalled hop holds per direction
const MAX_LINK_BUFFER = 8 * 1024 * 1024;       // a peer that stops reading gets cut off
const BILL_INTERVAL_MS = 1000;
const MAX_BAD_VOUCHERS = 32;

export function createRelay(opts = {}) {
  const {
    identity, kx, host = '0.0.0.0', exit = false, onVoucher = null, descriptor = null,
    allowPrivateTargets = false, allowPrivateRelays = false,
    maxCircuits = 1000, maxCircuitsPerConnection = 128, maxStreamsPerCircuit = 64, maxConnections = 2000,
    handshakeTimeoutMs = 10_000, extendTimeoutMs = 10_000, connectTimeoutMs = 15_000, idleTimeoutMs = 5 * 60_000,
    resolve, _tap = null,
  } = opts;
  if (!identity || !kx) throw new Error('relay: identity and kx are required');
  if (descriptor) {
    if (descriptor.id !== identity.id) throw new Error('relay: descriptor id does not match identity');
    if (descriptor.kx !== kx.pub) throw new Error('relay: descriptor kx does not match kx key');
  }
  const log = normLog(opts.log);
  const meter = opts.meter || createMeter();
  let price = BigInt(descriptor?.prices?.perMbLamports ?? opts.perMbLamports ?? 0);
  let creditLimit = BigInt(opts.creditLimitLamports ?? price);
  let listenPort = Number(opts.port || 0);

  let server = null;
  const conns = new Set();
  const circuits = new Set();
  const st = {
    connections: 0, circuitsCreated: 0, circuitsRefused: 0, cellsIn: 0, cellsOut: 0, bytesCarried: 0,
    vouchersAccepted: 0, vouchersRejected: 0, stalls: 0, maxQueue: 0, streamsOpened: 0, streamsRefused: 0, integrityFailures: 0,
  };

  const tap = (ev, data) => { if (_tap) try { _tap(ev, data); } catch { /* test hook */ } };

  function writeSock(sock, cell) {
    if (!sock || sock.destroyed) return;
    if (sock.writableLength > MAX_LINK_BUFFER) { sock.destroy(); return; }
    st.cellsOut++;
    sock.write(cell);
  }

  // ---------- incoming links ----------
  function onConnection(sock) {
    if (conns.size >= maxConnections) { sock.destroy(); return; }
    conns.add(sock);
    st.connections++;
    sock.setNoDelay(true);
    tap('conn-in', { remoteAddress: sock.remoteAddress, remotePort: sock.remotePort });
    const circs = new Map();
    sock._circs = circs;
    let gotCreate = false;
    const hsTimer = setTimeout(() => { if (!gotCreate) sock.destroy(); }, handshakeTimeoutMs);
    sock.setTimeout(idleTimeoutMs, () => sock.destroy());
    sock.on('data', cellReader((cell) => {
      st.cellsIn++;
      tap('cell-in', { side: 'prev', cell: Buffer.from(cell) });
      const circId = cell.readUInt32BE(0), cmd = cell[4], payload = cell.subarray(5);
      if (cmd === CMD.CREATE) { gotCreate = true; return onCreate(sock, circs, circId, payload); }
      const circ = circs.get(circId);
      if (!circ) return;
      if (cmd === CMD.RELAY) return onForward(circ, payload);
      if (cmd === CMD.DESTROY) return destroyCircuit(circ, 'destroyed by previous hop', { fromPrev: true });
    }));
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(hsTimer);
      conns.delete(sock);
      for (const circ of [...circs.values()]) destroyCircuit(circ, 'previous hop link closed', { fromPrev: true });
    });
  }

  function onCreate(sock, circs, circId, payload) {
    if (circId === 0 || circs.has(circId)) { writeSock(sock, destroyCell(circId, DESTROY_REASON.PROTOCOL)); return; }
    if (circuits.size >= maxCircuits || circs.size >= maxCircuitsPerConnection) {
      st.circuitsRefused++;
      writeSock(sock, destroyCell(circId, DESTROY_REASON.RESOURCE));
      return;
    }
    if (payload[0] !== HS_TYPE) { writeSock(sock, destroyCell(circId, DESTROY_REASON.PROTOCOL)); return; }
    let hs;
    try { hs = serverHandshake({ identity, kx }, payload.subarray(1, 33)); } catch {
      writeSock(sock, destroyCell(circId, DESTROY_REASON.PROTOCOL));
      return;
    }
    const circ = {
      prev: sock, prevId: circId, next: null, nextId: 0, extending: false,
      keys: hs.keys, session: hs.keys.session, payer: null, lastVoucher: null, badVouchers: 0,
      stalled: false, qF: [], qB: [], billTimer: null, lastBilled: 0n, voucherChain: Promise.resolve(),
      closed: false, edge: null, createdAt: Date.now(), price, limit: creditLimit,
    };
    circs.set(circId, circ);
    circuits.add(circ);
    st.circuitsCreated++;
    meter.open(circ.session, { kind: 'relay', priceLamports: circ.price, payer: undefined });
    writeSock(sock, linkCell(circId, CMD.CREATED, hs.reply));
  }

  // ---------- payment gate ----------
  function unpaid(circ) { return circ.price === 0n ? 0n : meter.unpaid(circ.session); }

  function canCarry(circ) {
    if (circ.closed) return false;
    if (circ.price === 0n) return true;
    const u = unpaid(circ);
    if (u > circ.limit) { stall(circ); return false; }
    if (u * 2n >= circ.limit) {
      const owed = meter.owed(circ.session);
      if ((owed - circ.lastBilled) * 4n >= circ.limit || circ.lastBilled === 0n) sendBill(circ);
    }
    return true;
  }

  function carried(circ) {
    st.bytesCarried += CELL_SIZE;
    if (meter.has(circ.session)) meter.add(circ.session, CELL_SIZE);
  }

  function stall(circ) {
    if (circ.stalled) return;
    circ.stalled = true;
    st.stalls++;
    sendBill(circ);
    circ.billTimer = setInterval(() => { if (!circ.closed && circ.stalled) sendBill(circ); }, BILL_INTERVAL_MS);
    circ.billTimer.unref?.();
  }

  function maybeResume(circ) {
    if (!circ.stalled || circ.closed) return;
    if (unpaid(circ) > circ.limit) return;
    circ.stalled = false;
    clearInterval(circ.billTimer); circ.billTimer = null;
    drain(circ);
  }

  function sendBill(circ) {
    if (circ.closed) return;
    const owed = meter.owed(circ.session);
    circ.lastBilled = owed;
    const info = meter.get(circ.session);
    sendControlNow(circ, R.BILL, 0, jsonData({
      session: circ.session, owed: owed.toString(), paid: info.paid.toString(), limit: circ.limit.toString(),
      perMbLamports: circ.price.toString(), stalled: circ.stalled,
    }));
  }

  function handleVoucher(circ, msg) {
    circ.voucherChain = circ.voucherChain.then(async () => {
      if (circ.closed) return;
      const v = parseJson(msg.data);
      let reason = null;
      if (!v || typeof v !== 'object') reason = 'malformed';
      else if (v.kind !== 'relay') reason = 'wrong kind';
      else if (v.session !== circ.session) reason = 'wrong session';
      else {
        const r = checkVoucher(v, { node: identity.id, prev: circ.lastVoucher });
        if (!r.ok) reason = r.reason;
      }
      if (!reason && onVoucher) {
        try {
          const res = await onVoucher(v);
          if (!res || res.ok === false) reason = (res && res.reason) || 'refused';
        } catch { reason = 'refused'; }
      }
      if (circ.closed) return;
      if (reason) {
        st.vouchersRejected++;
        circ.badVouchers++;
        sendControlNow(circ, R.VOUCHER_RESULT, 0, jsonData({ ok: false, reason, seq: v?.seq ?? null }));
        if (circ.badVouchers > MAX_BAD_VOUCHERS) destroyCircuit(circ, 'too many bad vouchers');
        return;
      }
      st.vouchersAccepted++;
      circ.lastVoucher = v;
      circ.payer = v.payer;
      meter.setPaid(circ.session, BigInt(v.cumulative));
      sendControlNow(circ, R.VOUCHER_RESULT, 0, jsonData({ ok: true, seq: v.seq, paid: v.cumulative }));
      maybeResume(circ);
    }).catch((e) => log.warn('relay: voucher handling failed', { err: e.message }));
  }

  // ---------- forward direction (toward the exit) ----------
  function onForward(circ, payload) {
    if (circ.closed) return;
    const r = peelForward(circ.keys, payload);
    if (!r) { st.integrityFailures++; return destroyCircuit(circ, 'integrity'); }
    if (r.mine) {
      const msg = unpackMsg(r.pt);
      if (!msg) return destroyCircuit(circ, 'protocol');
      if (msg.rcmd === R.VOUCHER) { carried(circ); return handleVoucher(circ, msg); }
      msg.data = Buffer.from(msg.data);
      if (circ.stalled || circ.qF.length) return enqueue(circ, circ.qF, { local: msg });
      if (!canCarry(circ)) return enqueue(circ, circ.qF, { local: msg });
      carried(circ);
      return handleLocal(circ, msg);
    }
    if (!circ.next || circ.extending) return destroyCircuit(circ, 'protocol');
    if (circ.stalled || circ.qF.length || !canCarry(circ)) return enqueue(circ, circ.qF, { fwd: r.payload });
    carried(circ);
    writeSock(circ.next, linkCell(circ.nextId, CMD.RELAY, r.payload));
  }

  function enqueue(circ, q, item) {
    q.push(item);
    if (q.length > st.maxQueue) st.maxQueue = q.length;
    if (q.length > MAX_QUEUE) destroyCircuit(circ, 'queue overflow');
  }

  function drain(circ) {
    while (circ.qF.length && !circ.closed && canCarry(circ)) {
      const it = circ.qF.shift();
      carried(circ);
      if (it.fwd) writeSock(circ.next, linkCell(circ.nextId, CMD.RELAY, it.fwd));
      else handleLocal(circ, it.local);
    }
    while (circ.qB.length && !circ.closed && canCarry(circ)) {
      const it = circ.qB.shift();
      carried(circ);
      writeSock(circ.prev, linkCell(circ.prevId, CMD.RELAY, it.relay ? addBackward(circ.keys, it.relay) : originBackward(circ.keys, it.body)));
    }
    if (circ.edge && !circ.closed) circ.edge.pump();
  }

  // ---------- backward direction (toward the client) ----------
  function onBackward(circ, payload) {
    if (circ.closed) return;
    if (circ.stalled || circ.qB.length || !canCarry(circ)) return enqueue(circ, circ.qB, { relay: Buffer.from(payload) });
    carried(circ);
    writeSock(circ.prev, linkCell(circ.prevId, CMD.RELAY, addBackward(circ.keys, payload)));
  }

  // payment control: always goes out at once, even while stalled
  function sendControlNow(circ, rcmd, sid, data) {
    if (circ.closed && rcmd !== R.TRUNCATED) return;
    carried(circ);
    writeSock(circ.prev, linkCell(circ.prevId, CMD.RELAY, originBackward(circ.keys, packMsg(circ.keys.rb, rcmd, sid, data))));
  }

  // ordinary messages from this hop: keep order with queued cells
  function sendBack(circ, rcmd, sid, data) {
    if (circ.closed) return;
    const body = packMsg(circ.keys.rb, rcmd, sid, data);
    if (circ.stalled || circ.qB.length || !canCarry(circ)) return enqueue(circ, circ.qB, { body });
    carried(circ);
    writeSock(circ.prev, linkCell(circ.prevId, CMD.RELAY, originBackward(circ.keys, body)));
  }

  // ---------- messages for this hop ----------
  function handleLocal(circ, msg) {
    switch (msg.rcmd) {
      case R.EXTEND: return onExtend(circ, msg);
      case R.BEGIN: return onBegin(circ, msg);
      case R.DATA: case R.SENDME: case R.END:
        if (circ.edge) circ.edge.handle(msg);
        return;
      default: return; // unknown: ignore
    }
  }

  function onExtend(circ, msg) {
    const fail = (reason) => sendBack(circ, R.EXTENDED, 0, jsonData({ ok: false, reason }));
    if (circ.next || circ.extending || circ.edge) return fail('already extended');
    const req = parseJson(msg.data);
    if (!req || !validHost(req.host) || !validPort(req.port) || typeof req.hs !== 'string') return fail('bad request');
    const X = Buffer.from(req.hs, 'base64');
    if (X.length !== 32) return fail('bad request');
    circ.extending = true;
    (async () => {
      let addr;
      try { addr = await resolveTarget(req.host, { allowPrivate: allowPrivateRelays, resolve }); } catch (e) {
        circ.extending = false; return fail(e.code === 'policy' ? 'refused' : 'unreachable');
      }
      if (circ.closed) return;
      const sock = net.connect({ host: addr, port: req.port });
      sock.setNoDelay(true);
      const nextId = randomInt(1, 0xffffffff);
      let done = false;
      const timer = setTimeout(() => finish('timeout'), extendTimeoutMs);
      const finish = (err, reply) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        circ.extending = false;
        if (err || circ.closed) {
          sock.destroy();
          if (!circ.closed) fail(err === 'timeout' ? 'timeout' : 'unreachable');
          return;
        }
        circ.next = sock;
        circ.nextId = nextId;
        sendBack(circ, R.EXTENDED, 0, jsonData({ ok: true, reply: reply.toString('base64') }));
      };
      tap('conn-out', { host: addr, port: req.port });
      sock.on('connect', () => writeSock(sock, linkCell(nextId, CMD.CREATE, Buffer.concat([Buffer.from([HS_TYPE]), X]))));
      sock.on('data', cellReader((cell) => {
        st.cellsIn++;
        tap('cell-in', { side: 'next', cell: Buffer.from(cell) });
        if (cell.readUInt32BE(0) !== nextId) return;
        const cmd = cell[4];
        if (!done) {
          if (cmd === CMD.CREATED) return finish(null, Buffer.from(cell.subarray(5, 5 + HS_REPLY_LEN)));
          return finish('refused');
        }
        if (cmd === CMD.RELAY) return onBackward(circ, cell.subarray(5));
        if (cmd === CMD.DESTROY) return destroyCircuit(circ, 'destroyed by next hop', { fromNext: true });
      }));
      sock.on('error', () => {});
      sock.on('close', () => {
        if (!done) return finish('closed');
        if (!circ.closed) destroyCircuit(circ, 'next hop link closed', { fromNext: true });
      });
    })();
  }

  function ensureEdge(circ) {
    if (circ.edge) return circ.edge;
    circ.edge = createEdge({
      sendData: (sid, chunk) => { carried(circ); writeSock(circ.prev, linkCell(circ.prevId, CMD.RELAY, originBackward(circ.keys, packMsg(circ.keys.rb, R.DATA, sid, chunk)))); },
      sendControl: (rcmd, sid, data) => sendBack(circ, rcmd, sid, data),
      canSendData: () => !circ.closed && !circ.stalled && circ.qB.length === 0 && canCarry(circ),
      violation: (reason) => destroyCircuit(circ, 'flow control: ' + reason),
    }, { maxStreams: maxStreamsPerCircuit });
    return circ.edge;
  }

  function onBegin(circ, msg) {
    const sid = msg.streamId;
    const refuse = (reason) => { st.streamsRefused++; sendBack(circ, R.END, sid, Buffer.from(reason)); };
    if (!exit || circ.next || circ.extending) return refuse('not exit');
    if (sid === 0) return refuse('bad request');
    const req = parseJson(msg.data);
    if (!req || !validHost(req.host) || !validPort(req.port)) return refuse('bad request');
    const edge = ensureEdge(circ);
    const stream = edge.add(sid);
    if (!stream) return refuse('limit');
    st.streamsOpened++;
    let target = null;
    let connected = false;
    stream.on('error', () => {});
    stream.on('close', () => {
      if (!target || target.destroyed) return;
      if (target.writableEnded) setTimeout(() => target.destroy(), 30_000).unref?.(); // let queued bytes flush
      else target.destroy();
    });
    (async () => {
      let addr;
      try { addr = await resolveTarget(req.host, { allowPrivate: allowPrivateTargets, resolve }); } catch (e) {
        stream.endSent = true; stream.destroy();
        return refuse(e.code === 'policy' ? 'refused' : 'resolve');
      }
      if (circ.closed || stream.destroyed) return;
      target = net.connect({ host: addr, port: req.port });
      const timer = setTimeout(() => { if (!connected) target.destroy(new Error('timeout')); }, connectTimeoutMs);
      target.on('connect', () => {
        connected = true;
        clearTimeout(timer);
        if (circ.closed || stream.destroyed) return target.destroy();
        sendBack(circ, R.CONNECTED, sid, jsonData({ ok: true }));
        target.pipe(stream);
        stream.pipe(target);
      });
      target.on('error', (err) => {
        clearTimeout(timer);
        if (!connected) {
          if (!stream.destroyed) { stream.endSent = true; stream.destroy(); }
          return refuse(err.message === 'timeout' ? 'timeout' : (err.code === 'ECONNREFUSED' ? 'connect refused' : 'connect failed'));
        }
        stream.destroy(err);
      });
      target.on('close', () => { if (connected && !stream.destroyed && !stream.writableEnded) stream.end(); });
    })();
  }

  // ---------- teardown ----------
  function destroyCircuit(circ, reason, { fromPrev = false, fromNext = false } = {}) {
    if (circ.closed) return;
    log.debug('relay: circuit closed', { reason });
    if (fromNext && !fromPrev && circ.prev && !circ.prev.destroyed) {
      // tell the client which hop is gone, then close our side
      circ.closed = true;
      sendControlNow(circ, R.TRUNCATED, 0, jsonData({ reason }));
    }
    circ.closed = true;
    if (!fromPrev) writeSock(circ.prev, destroyCell(circ.prevId, fromNext ? DESTROY_REASON.HOP_LOST : DESTROY_REASON.CLOSED));
    if (circ.next) {
      if (!fromNext) writeSock(circ.next, destroyCell(circ.nextId, DESTROY_REASON.CLOSED));
      circ.next.end();
      setTimeout(() => circ.next.destroy(), 2000).unref?.();
    }
    if (circ.edge) circ.edge.closeAll(new Error('circuit closed'));
    clearInterval(circ.billTimer);
    circ.qF.length = 0; circ.qB.length = 0;
    circ.prev?._circs?.delete(circ.prevId);
    circuits.delete(circ);
    meter.close(circ.session);
  }

  return {
    get port() { return listenPort; },
    start() {
      return new Promise((resolveStart, reject) => {
        server = net.createServer(onConnection);
        server.maxConnections = maxConnections;
        server.once('error', reject);
        server.listen(listenPort, host, () => {
          listenPort = server.address().port;
          log.info('relay: listening', { port: listenPort, exit });
          resolveStart({ port: listenPort });
        });
      });
    },
    stop() {
      for (const circ of [...circuits]) destroyCircuit(circ, 'shutdown');
      for (const s of conns) s.destroy();
      conns.clear();
      return new Promise((r) => { if (!server) return r(); server.close(() => r()); server = null; });
    },
    stats() {
      let streams = 0, stalled = 0, queued = 0;
      for (const c of circuits) {
        if (c.edge) streams += c.edge.streams.size;
        if (c.stalled) stalled++;
        queued += c.qF.length + c.qB.length;
      }
      return { ...st, circuits: circuits.size, streams, stalledCircuits: stalled, queuedCells: queued, openConnections: conns.size };
    },
    // The descriptor needs the listening port, so the daemon may sign it after start()
    // and hand it over here. Its price applies to circuits created from now on.
    setDescriptor(d) {
      if (d.id !== identity.id || d.kx !== kx.pub) throw new Error('relay: descriptor does not match this relay');
      price = BigInt(d.prices?.perMbLamports ?? 0);
      if (opts.creditLimitLamports == null) creditLimit = price;
    },
    // for tests and the node daemon: session ids currently metered here
    sessions() { return [...circuits].map((c) => ({ session: c.session, payer: c.payer, stalled: c.stalled, paid: c.lastVoucher?.cumulative ?? '0' })); },
  };
}
