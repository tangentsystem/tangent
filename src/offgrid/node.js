// The off grid node: store and forward gossip of durable nonce Solana transactions over any
// set of transports, with a gateway mode that submits them on chain and sends signed receipts
// back through the mesh.
import { b58 } from '../core/index.js';
import {
  T, KIND, DEFAULT_MTU, decodeFrame, fragment, encodeInv, encodeWant, encodeNack, encodeHello,
  createReassembler, maxIdsPerFrame, hex, unhex,
} from './codec.js';
import {
  inspectTx, tipFromTx, createBundle, encodeBundle, decodeBundle, validateBundle, appendTrail,
  expiresAtMs, MAX_TRAIL,
} from './bundle.js';
import { signReceipt, checkReceipt, buildClaim } from './receipt.js';
import { readNonceValue } from './nonce.js';
import { PublicKey } from '@solana/web3.js';

const DEFAULTS = Object.freeze({
  mtu: DEFAULT_MTU,
  tickMs: 250,
  gossipIntervalMs: 5000,
  helloIntervalMs: 10_000,
  wantRetryMs: 3000,
  nackAfterMs: 1000,
  maxNacks: 5,
  partialTtlMs: 60_000,
  maxBundles: 1000,
  maxBundleBytes: 2 * 1024 * 1024,
  maxReceipts: 5000,
  receiptTtlMs: 3 * 24 * 3600 * 1000,
  receiptAnnounceMs: 10 * 60 * 1000,
  peerTtlMs: 5 * 60 * 1000,
  frameRatePerSec: 100,
  frameBurst: 400,
  objectsPerMinute: 120,
  defaultMaxHops: 8,
  defaultMaxAgeSec: 3 * 24 * 3600,
  // gateway
  confirmTimeoutMs: 60_000,
  pollMs: 1000,
  retryMs: 5000,
  maxAttempts: 10,
  perTxLamports: 0n,
});

export function createOffgrid({
  identity, transports = [], store, gateway = null, meter = null, log = () => {},
  tipAccount = null, trustedGateways = null, now = () => Date.now(), ...overrides
}) {
  if (!identity) throw new Error('offgrid: identity required');
  if (!store) throw new Error('offgrid: store required');
  const o = { ...DEFAULTS, ...overrides };
  const conn = gateway?.connection ?? null;
  const me = identity.id;

  const peerMap = new Map();      // key -> peer state
  const bundles = new Map();      // id -> { b, bytes, own, expiresAt }
  const receipts = new Map();     // bundleId -> { r, json, firstAt }
  const done = new Map();         // bundleId -> expiresAt (tombstones)
  const rejectedIds = new Map();  // bundleId -> until
  const completed = new Map();    // digestHex -> at (recently completed objects, ignore extra frames)
  const outbox = new Map();       // digestHex -> { kind, frames, at }
  const wants = new Map();        // 'kind:prefix' -> at
  const queue = new Map();        // gateway submissions: id -> { attempts, nextAt, busy }
  const receiptCbs = [], claimCbs = [];
  const firedReceipts = new Set();
  const claims = new Map();
  const inflight = new Set();
  const st = {
    framesIn: 0, framesOut: 0, badFrames: 0, dupFrames: 0, rateLimited: 0, nacksSent: 0, nacksServed: 0,
    bundlesAccepted: 0, bundlesRejected: 0, duplicates: 0, evicted: 0, receiptsAccepted: 0, receiptsRejected: 0,
    submitted: 0, landed: 0, failed: 0, sendCalls: 0, gatewayRetries: 0, gatewayGaveUp: 0, rejectReasons: {},
  };
  let timer = null, running = false, lastGossip = 0, lastHello = 0;
  const reasm = createReassembler({ partialTtlMs: o.partialTtlMs, now });

  const prefixOf = (id) => id.slice(0, 16);
  const lru = (map, max) => { while (map.size > max) map.delete(map.keys().next().value); };
  const reject = (reason, extra = '') => { st.bundlesRejected++; st.rejectReasons[reason] = (st.rejectReasons[reason] || 0) + 1; log(`offgrid: rejected bundle (${reason}) ${extra}`); };

  // ------------------------------------------------------------ peers and rate limits
  function peerFor(transport, peer) {
    const key = transport.name + '|' + peer.id;
    let p = peerMap.get(key);
    if (!p) {
      p = { key, transport, peer, nodeId: null, gateway: false, lastSeen: now(), framesIn: 0, framesOut: 0, tokens: o.frameBurst, tokAt: now(), objWindow: now(), objCount: 0, dropped: 0 };
      peerMap.set(key, p);
    }
    p.peer = peer; p.lastSeen = now();
    return p;
  }
  function takeFrameToken(p) {
    const t = now();
    p.tokens = Math.min(o.frameBurst, p.tokens + ((t - p.tokAt) / 1000) * o.frameRatePerSec); p.tokAt = t;
    if (p.tokens < 1) return false;
    p.tokens -= 1; return true;
  }
  function takeObjectToken(p) {
    const t = now();
    if (t - p.objWindow > 60_000) { p.objWindow = t; p.objCount = 0; }
    if (p.objCount >= o.objectsPerMinute) return false;
    p.objCount++; return true;
  }
  function sendTo(p, frame) {
    try { p.transport.send(frame, p.peer); st.framesOut++; p.framesOut++; } catch (e) { log('offgrid: send failed ' + e.message); }
  }
  function broadcast(frame) {
    for (const t of transports) { try { t.send(frame); st.framesOut++; } catch (e) { log('offgrid: broadcast failed ' + e.message); } }
  }

  // ------------------------------------------------------------ objects
  function sendObject(p, kind, bytes) {
    const { digest, frames } = fragment(kind, bytes, o.mtu);
    const key = hex(digest);
    outbox.set(key, { kind, frames, at: now() }); lru(outbox, 256);
    for (const f of frames) sendTo(p, f);
  }
  function lookup(kind, prefixHex) {
    if (kind === KIND.BUNDLE) {
      for (const [id, rec] of bundles) if (prefixOf(id) === prefixHex) return rec.bytes;
    } else if (kind === KIND.RECEIPT) {
      for (const [id, rec] of receipts) if (prefixOf(id) === prefixHex) return new TextEncoder().encode(rec.json);
    }
    return null;
  }
  function known(kind, prefixHex) {
    const t = now();
    const match = (map) => { for (const id of map.keys()) if (prefixOf(id) === prefixHex) return true; return false; };
    if (kind === KIND.RECEIPT) return match(receipts);
    if (kind === KIND.BUNDLE) {
      if (match(bundles) || match(done) || match(receipts)) return true;
      for (const [id, until] of rejectedIds) { if (until < t) rejectedIds.delete(id); else if (prefixOf(id) === prefixHex) return true; }
      return false;
    }
    return true; // unknown kinds: never ask for them
  }

  // ------------------------------------------------------------ inventory
  function invEntries() {
    const t = now(), out = [];
    for (const [id, rec] of bundles) if (rec.b.hops < rec.b.maxHops && rec.expiresAt > t) out.push({ kind: KIND.BUNDLE, prefix: unhex(prefixOf(id)) });
    for (const [id, rec] of receipts) if (t - rec.firstAt < o.receiptAnnounceMs) out.push({ kind: KIND.RECEIPT, prefix: unhex(prefixOf(id)) });
    return out;
  }
  function announce(entries = invEntries()) {
    const per = maxIdsPerFrame(o.mtu);
    for (let i = 0; i < entries.length; i += per) broadcast(encodeInv(entries.slice(i, i + per)));
  }
  function hello() { broadcast(encodeHello(identity.publicKey, conn ? 1 : 0)); }

  // ------------------------------------------------------------ frames in
  function onFrame(transport, bytes, peer) {
    if (!running) return;
    const p = peerFor(transport, peer || { id: 'unknown' });
    st.framesIn++; p.framesIn++;
    if (!takeFrameToken(p)) { st.rateLimited++; p.dropped++; return; }
    const f = decodeFrame(bytes);
    if (!f) { st.badFrames++; return; }
    if (f.type === T.HELLO) {
      p.nodeId = b58(f.nodeId); p.gateway = !!(f.flags & 1);
      return;
    }
    if (p.nodeId === me) return; // our own echo on a shared medium
    if (f.type === T.INV) {
      const want = [], t = now();
      for (const e of f.entries) {
        const ph = hex(e.prefix), k = e.kind + ':' + ph;
        if (known(e.kind, ph)) continue;
        if (wants.has(k) && t - wants.get(k) < o.wantRetryMs) continue;
        wants.set(k, t); want.push(e);
      }
      lru(wants, 4096);
      const per = maxIdsPerFrame(o.mtu);
      for (let i = 0; i < want.length; i += per) sendTo(p, encodeWant(want.slice(i, i + per)));
      return;
    }
    if (f.type === T.WANT) {
      for (const e of f.entries) {
        const bytes2 = lookup(e.kind, hex(e.prefix));
        if (!bytes2) continue;
        if (!takeObjectToken(p)) { st.rateLimited++; break; }
        sendObject(p, e.kind, bytes2);
      }
      return;
    }
    if (f.type === T.NACK) {
      const ob = outbox.get(hex(f.digest));
      if (!ob || ob.frames.length !== f.total) return;
      st.nacksServed++;
      for (const i of f.missing) if (ob.frames[i]) sendTo(p, ob.frames[i]);
      return;
    }
    if (f.type === T.DATA) {
      const dk = hex(f.digest);
      if (completed.has(dk)) { st.dupFrames++; return; }
      const res = reasm.push(f, p.key);
      if (res.status === 'duplicate') { st.dupFrames++; return; }
      if (res.status === 'corrupt' || res.status === 'mismatch') { st.badFrames++; return; }
      if (res.status !== 'complete') return;
      completed.set(dk, now()); lru(completed, 2048);
      if (!takeObjectToken(p)) { st.rateLimited++; return; }
      handleObject(res.kind, res.bytes, p).catch((e) => log('offgrid: object error ' + e.message));
    }
  }

  async function handleObject(kind, bytes, p) {
    if (kind === KIND.BUNDLE) return acceptBundle(bytes, p);
    if (kind === KIND.RECEIPT) return acceptReceipt(new TextDecoder().decode(bytes));
  }

  // ------------------------------------------------------------ bundles
  async function putBundle(rec) {
    const ttlMs = Math.max(1, rec.expiresAt - now());
    await store.put('b/' + rec.b.id, { bytes: Buffer.from(rec.bytes).toString('base64'), own: rec.own }, { ttlMs });
    bundles.set(rec.b.id, rec);
    await evict();
  }
  async function evict() {
    let bytesTotal = 0; for (const r of bundles.values()) bytesTotal += r.bytes.length;
    while (bundles.size > o.maxBundles || bytesTotal > o.maxBundleBytes) {
      let victim = null;
      for (const r of bundles.values()) {
        if (!victim || (victim.own && !r.own) || (victim.own === r.own && r.expiresAt < victim.expiresAt)) victim = r;
      }
      if (!victim) break;
      bundles.delete(victim.b.id); queue.delete(victim.b.id); bytesTotal -= victim.bytes.length;
      await store.delete('b/' + victim.b.id); st.evicted++;
      log('offgrid: evicted bundle ' + victim.b.id.slice(0, 12));
    }
  }

  async function acceptBundle(bytes, p) {
    let b;
    try { b = decodeBundle(bytes); } catch (e) { reject(e.message.replace(/^bundle: /, '')); return; }
    if (receipts.has(b.id)) { st.duplicates++; announce([{ kind: KIND.RECEIPT, prefix: unhex(prefixOf(b.id)) }]); return; }
    if (done.has(b.id) || bundles.has(b.id) || inflight.has(b.id)) { st.duplicates++; return; }
    inflight.add(b.id);
    try { await acceptBundleInner(b, p); } finally { inflight.delete(b.id); }
  }
  async function acceptBundleInner(b, p) {
    const v = validateBundle(b, { now: now() });
    if (!v.ok) { reject(v.reason, b.id.slice(0, 12)); rejectedIds.set(b.id, now() + 60_000); lru(rejectedIds, 4096); return; }
    if (b.hops + 1 > b.maxHops) { reject('hop limit', b.id.slice(0, 12)); return; }
    b.hops += 1;
    if (!conn && b.origin !== me && b.trail.length < MAX_TRAIL && !b.trail.some((e) => e.node === me)) b.trail = appendTrail(b.id, b.trail, identity);
    const rec = { b, bytes: encodeBundle(b), own: false, expiresAt: expiresAtMs(b) };
    await putBundle(rec);
    st.bundlesAccepted++;
    log(`offgrid: carrying bundle ${b.id.slice(0, 12)} hops ${b.hops}/${b.maxHops}${p ? ' from ' + p.key : ''}`);
    if (b.hops < b.maxHops) announce([{ kind: KIND.BUNDLE, prefix: unhex(prefixOf(b.id)) }]);
    if (conn) enqueue(b.id);
  }

  async function submit(signedTxBytes, opts = {}) {
    const txBytes = Uint8Array.from(signedTxBytes);
    const t = inspectTx(txBytes);
    if (!t.ok) throw new Error('offgrid: ' + t.reason);
    const tipAcc = opts.tipAccount ?? tipAccount;
    const tipLamports = tipAcc ? tipFromTx(t.info, tipAcc) : 0n;
    const b = createBundle({
      identity, txBytes, maxHops: opts.maxHops ?? o.defaultMaxHops, maxAge: opts.maxAgeSec ?? o.defaultMaxAgeSec,
      created: Math.floor(now() / 1000), tip: tipLamports > 0n ? { account: tipAcc, lamports: tipLamports } : null,
    });
    const v = validateBundle(b, { now: now() });
    if (!v.ok) throw new Error('offgrid: ' + v.reason);
    if (bundles.has(b.id) || receipts.has(b.id)) return b.id;
    await putBundle({ b, bytes: encodeBundle(b), own: true, expiresAt: expiresAtMs(b) });
    log('offgrid: submitted bundle ' + b.id.slice(0, 12));
    if (running) announce([{ kind: KIND.BUNDLE, prefix: unhex(prefixOf(b.id)) }]);
    if (conn) enqueue(b.id);
    return b.id;
  }

  // ------------------------------------------------------------ receipts
  async function acceptReceipt(json, { local = false } = {}) {
    let r;
    try { r = JSON.parse(json); } catch { st.receiptsRejected++; return; }
    if (!r || typeof r.bundleId !== 'string') { st.receiptsRejected++; return; }
    if (receipts.has(r.bundleId) || inflight.has('r' + r.bundleId)) return;
    inflight.add('r' + r.bundleId);
    try { await acceptReceiptInner(r, json, local); } finally { inflight.delete('r' + r.bundleId); }
  }
  async function acceptReceiptInner(r, json, local) {
    const rec = bundles.get(r.bundleId);
    const txSig = rec ? inspectTx(rec.b.tx).info.signatures[0] : null;
    const c = checkReceipt(r, { txSignature: txSig, origin: rec ? rec.b.origin : null });
    if (!c.ok) { st.receiptsRejected++; log('offgrid: rejected receipt (' + c.reason + ')'); return; }
    if (!local && trustedGateways && !trustedGateways.includes(r.gateway)) { st.receiptsRejected++; log('offgrid: receipt from untrusted gateway'); return; }
    receipts.set(r.bundleId, { r, json, firstAt: now() });
    st.receiptsAccepted++;
    while (receipts.size > o.maxReceipts) { const k = receipts.keys().next().value; receipts.delete(k); await store.delete('r/' + k); }
    await store.put('r/' + r.bundleId, { json }, { ttlMs: o.receiptTtlMs });
    // stop forwarding: drop the bundle, keep a tombstone so it is not accepted again
    const until = rec ? Math.max(rec.expiresAt, now() + 60_000) : now() + o.receiptTtlMs;
    done.set(r.bundleId, until);
    await store.put('d/' + r.bundleId, { until }, { ttlMs: Math.max(1, until - now()) });
    if (rec) { bundles.delete(r.bundleId); await store.delete('b/' + r.bundleId); }
    queue.delete(r.bundleId);
    if (running) announce([{ kind: KIND.RECEIPT, prefix: unhex(prefixOf(r.bundleId)) }]);
    if (r.origin === me && !firedReceipts.has(r.bundleId)) {
      firedReceipts.add(r.bundleId);
      for (const cb of receiptCbs) { try { cb(r); } catch (e) { log('offgrid: onReceipt handler ' + e.message); } }
    }
    if (r.status === 'landed' && (r.gateway === me || r.trail.some((e) => e.node === me))) {
      const claim = buildClaim(identity, r, { ts: now() });
      claims.set(r.bundleId, claim);
      await store.put('c/' + r.bundleId, claim, { ttlMs: o.receiptTtlMs });
      for (const cb of claimCbs) { try { cb(claim); } catch (e) { log('offgrid: onClaim handler ' + e.message); } }
    }
  }

  // ------------------------------------------------------------ gateway
  function enqueue(id) {
    if (!conn || queue.has(id) || receipts.has(id)) return;
    queue.set(id, { attempts: 0, nextAt: now(), busy: false });
    if (running) setImmediate(runQueue);
  }
  function runQueue() {
    const t = now();
    for (const [id, q] of queue) if (!q.busy && q.nextAt <= t) processOne(id, q);
  }
  const sleep = (ms) => new Promise((r) => { const tm = setTimeout(r, ms); tm.unref?.(); });

  async function statusOf(sig) {
    const res = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const s = res?.value?.[0];
    if (!s) return null;
    if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' || s.confirmations === null) return s;
    return null;
  }
  function outcome(s, sig) {
    return s.err ? { status: 'failed', signature: sig, slot: s.slot, reason: 'transaction error ' + JSON.stringify(s.err).slice(0, 80) } : { status: 'landed', signature: sig, slot: s.slot };
  }
  async function confirm(sig) {
    const end = now() + o.confirmTimeoutMs;
    for (;;) {
      const s = await statusOf(sig);
      if (s) return outcome(s, sig);
      if (now() >= end) return { status: 'retry', reason: 'confirm timeout' };
      await sleep(o.pollMs);
    }
  }
  async function submitTx(b) {
    const info = inspectTx(b.tx).info;
    const sig = info.signatures[0];
    const prior = await statusOf(sig); // replay or another gateway already landed it
    if (prior) return outcome(prior, sig);
    try {
      st.sendCalls++;
      await conn.sendRawTransaction(b.tx, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 });
    } catch (e) {
      const msg = String(e?.message || e);
      if (/already been processed|AlreadyProcessed/i.test(msg)) return confirm(sig);
      if (/blockhash not found|BlockhashNotFound/i.test(msg)) {
        const again = await statusOf(sig);
        if (again) return outcome(again, sig);
        const acc = await conn.getAccountInfo(new PublicKey(info.nonce.account));
        if (!acc) return { status: 'failed', signature: sig, slot: null, reason: 'nonce account missing' };
        let cur = null;
        try { cur = readNonceValue(acc.data); } catch { return { status: 'failed', signature: sig, slot: null, reason: 'not a nonce account' }; }
        if (cur !== info.nonce.value) return { status: 'failed', signature: sig, slot: null, reason: 'nonce used' };
        return { status: 'retry', reason: 'blockhash not found' };
      }
      if (/simulation failed|InstructionError|Error processing Instruction|insufficient|custom program error|AccountNotFound|InsufficientFunds/i.test(msg)) {
        return { status: 'failed', signature: sig, slot: null, reason: msg.replace(/^.*simulation failed:\s*/i, '').slice(0, 120) };
      }
      return { status: 'retry', reason: msg.slice(0, 120) };
    }
    return confirm(sig);
  }

  async function processOne(id, q) {
    const rec = bundles.get(id);
    if (!rec || receipts.has(id)) { queue.delete(id); return; }
    q.busy = true;
    let res;
    try { res = await submitTx(rec.b); } catch (e) { res = { status: 'retry', reason: String(e?.message || e).slice(0, 120) }; }
    q.busy = false;
    if (res.status === 'retry') {
      q.attempts++; st.gatewayRetries++;
      if (q.attempts >= o.maxAttempts) { queue.delete(id); st.gatewayGaveUp++; log(`offgrid: gateway gave up on ${id.slice(0, 12)} (${res.reason})`); return; }
      q.nextAt = now() + Math.min(o.retryMs * 2 ** (q.attempts - 1), 10 * 60_000);
      log(`offgrid: gateway retry ${id.slice(0, 12)} (${res.reason})`);
      return;
    }
    queue.delete(id);
    st.submitted++;
    if (res.status === 'landed') {
      st.landed++;
      if (meter) {
        const session = o.meterSession ?? 'offgrid:' + me;
        if (!meter.has(session)) meter.open(session, { kind: 'offgrid', priceLamports: o.perTxLamports, payer: o.meterPayer ?? 'mesh' });
        meter.add(session, 1);
      }
    } else st.failed++;
    log(`offgrid: gateway ${res.status} ${id.slice(0, 12)} ${res.signature}${res.reason ? ' (' + res.reason + ')' : ''}`);
    const r = signReceipt(identity, {
      bundleId: id, status: res.status, signature: res.signature, slot: res.slot ?? null, reason: res.reason,
      origin: rec.b.origin, trail: rec.b.trail, ts: now(),
    });
    await acceptReceipt(JSON.stringify(r), { local: true });
  }

  // ------------------------------------------------------------ timer
  function tick() {
    if (!running) return;
    const t = now();
    if (t - lastHello >= o.helloIntervalMs) { lastHello = t; hello(); }
    if (t - lastGossip >= o.gossipIntervalMs) { lastGossip = t; announce(); }
    for (const { st: ps, missing } of reasm.idle(o.nackAfterMs)) {
      if (ps.nacks >= o.maxNacks) continue;
      ps.nacks++; ps.lastAt = t;
      const nack = encodeNack(ps.kind, ps.digest, ps.total, missing);
      for (const pk of ps.peers) { const p = peerMap.get(pk); if (p) { sendTo(p, nack); st.nacksSent++; } }
    }
    for (const [id, rec] of bundles) if (rec.expiresAt <= t) { bundles.delete(id); queue.delete(id); store.delete('b/' + id).catch(() => {}); }
    for (const [id, until] of done) if (until <= t) done.delete(id);
    for (const [k, v] of outbox) if (t - v.at > o.partialTtlMs) outbox.delete(k);
    for (const [k, p] of peerMap) if (t - p.lastSeen > o.peerTtlMs) peerMap.delete(k);
    if (conn) runQueue();
  }

  async function load() {
    for (const { key, value } of await store.list('d/')) done.set(key.slice(2), value.until);
    for (const { key, value } of await store.list('r/')) {
      try { const r = JSON.parse(value.json); receipts.set(key.slice(2), { r, json: value.json, firstAt: now() }); } catch { /* skip */ }
    }
    for (const { key, value } of await store.list('c/')) claims.set(key.slice(2), value);
    for (const { key, value } of await store.list('b/')) {
      try {
        const b = decodeBundle(new Uint8Array(Buffer.from(value.bytes, 'base64')));
        if (b.id !== key.slice(2) || done.has(b.id) || receipts.has(b.id)) continue;
        if (!validateBundle(b, { now: now() }).ok) { await store.delete(key); continue; }
        bundles.set(b.id, { b, bytes: encodeBundle(b), own: !!value.own, expiresAt: expiresAtMs(b) });
      } catch { await store.delete(key); }
    }
  }

  return {
    async start() {
      if (running) return;
      await load();
      running = true;
      for (const t of transports) await t.start((bytes, peer) => onFrame(t, bytes, peer));
      lastHello = now(); hello();
      lastGossip = now(); announce();
      if (conn) for (const id of bundles.keys()) enqueue(id);
      timer = setInterval(tick, o.tickMs); timer.unref?.();
      log(`Tangent Systems off grid node ${me} started (${conn ? 'gateway' : 'carrier'}, transports: ${transports.map((t) => t.name).join(', ') || 'none'}, ${bundles.size} bundles held)`);
    },
    async stop() {
      running = false; clearInterval(timer); timer = null;
      for (const t of transports) { try { await t.stop(); } catch { /* ignore */ } }
    },
    submit,
    onReceipt(cb) { receiptCbs.push(cb); return () => receiptCbs.splice(receiptCbs.indexOf(cb), 1); },
    onClaim(cb) { claimCbs.push(cb); return () => claimCbs.splice(claimCbs.indexOf(cb), 1); },
    claims() { return [...claims.values()]; },
    receipt(bundleId) { return receipts.get(bundleId)?.r ?? null; },
    has(bundleId) { return bundles.has(bundleId); },
    peers() {
      const t = now();
      return [...peerMap.values()].filter((p) => t - p.lastSeen <= o.peerTtlMs).map((p) => ({
        key: p.key, transport: p.transport.name, peer: p.peer.id, nodeId: p.nodeId, gateway: p.gateway,
        lastSeen: p.lastSeen, framesIn: p.framesIn, framesOut: p.framesOut, dropped: p.dropped,
      }));
    },
    stats() {
      let bytesTotal = 0; for (const r of bundles.values()) bytesTotal += r.bytes.length;
      return { ...st, rejectReasons: { ...st.rejectReasons }, bundles: bundles.size, bundleBytes: bytesTotal, receipts: receipts.size, partials: reasm.size(), queue: queue.size, gateway: !!conn, id: me };
    },
    id: me,
  };
}

