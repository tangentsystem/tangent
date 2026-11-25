// Node registry: registration, heartbeats, liveness, eviction, reputation and
// the signed directory. All state lives in the store:
//   nodes  { _id: id, descriptor, roles, hostKey, region, firstSeen, lastSeen,
//            lastHbTs, heartbeats, onTime, liveMs, load, redeemedCount, redeemedLamports }
//   hosts  { _id: "host:port", id }   (one owner per public address, conditional insert)
// A node is live while its last heartbeat (or registration) is within livenessMs.
// Live nodes are the directory. Nodes silent for evictAfterMs are removed by sweep().
import { checkDescriptor, descriptorBody, verifyObject } from '../core/index.js';
import { solscan } from '../config.js';
import { isPrivateHost } from './net.js';

export class CoordError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

const round3 = (x) => Math.round(x * 1000) / 1000;

// Reputation from uptime, heartbeat consistency and redeemed work. Score 0..1.
//   uptime       share of the time since first registration the node was live
//   consistency  share of heartbeats that arrived within 1.5 heartbeat intervals
//   work         log scale of redeemed vouchers, 1000 redemptions = full marks
//   score        0.5 uptime + 0.3 consistency + 0.2 work
export function reputationOf(node, now) {
  const age = Math.max(1, now - node.firstSeen);
  const uptime = Math.min(1, Number(node.liveMs || 0) / age);
  const hb = Number(node.heartbeats || 0);
  const consistency = hb > 0 ? Math.min(1, Number(node.onTime || 0) / hb) : 0;
  const count = Number(BigInt(node.redeemedCount || 0));
  const work = Math.min(1, Math.log10(1 + count) / 3);
  return { score: round3(0.5 * uptime + 0.3 * consistency + 0.2 * work), uptime: round3(uptime), consistency: round3(consistency), work: round3(work) };
}

export function createRegistry({ store, config, identity, stake = null, now = Date.now, log }) {
  const nodes = store.collection('nodes');
  const hosts = store.collection('hosts');
  const live = (n, t) => t - n.lastSeen <= config.livenessMs;

  async function init() {
    await nodes.ensureIndex('lastSeen');
    await nodes.ensureIndex('roles');
  }

  async function register(desc) {
    const t = now();
    const check = checkDescriptor(desc, { maxAgeMs: config.descriptorMaxAgeMs, now: t });
    if (!check.ok) {
      if (check.reason === 'signature') throw new CoordError(401, 'BAD_SIGNATURE', 'descriptor signature does not verify');
      if (check.reason === 'stale') throw new CoordError(400, 'STALE', 'descriptor timestamp is too far from now');
      throw new CoordError(400, 'INVALID', 'descriptor: ' + check.reason);
    }
    const body = stripUndefined(descriptorBody(desc));
    const descriptor = { ...body, sig: desc.sig };
    const host = body.host.toLowerCase();
    if (!host && !body.onion) throw new CoordError(400, 'INVALID', 'descriptor needs a host or an onion address');
    if (host) {
      if (!(body.port >= 1 && body.port <= 65535)) throw new CoordError(400, 'INVALID', 'descriptor port must be 1 to 65535');
      if (!config.allowPrivateHosts && isPrivateHost(host)) throw new CoordError(400, 'PRIVATE_HOST', 'host must be a public address');
    }
    if (stake && typeof stake.check === 'function') {
      const s = await stake.check(descriptor);
      if (!s || !s.ok) throw new CoordError(403, 'STAKE', (s && s.reason) || 'stake check failed');
    }
    const hostKey = host ? `${host}:${body.port}` : null;

    return store.transaction(async () => {
      const existing = await nodes.get(body.id);
      if (existing) {
        if (body.ts < existing.descriptor.ts) throw new CoordError(409, 'OLDER', 'a newer descriptor is already registered');
        if (body.ts === existing.descriptor.ts && existing.descriptor.sig === descriptor.sig) return { node: existing, created: false };
      }
      if (hostKey) {
        const mine = await hosts.insert({ _id: hostKey, id: body.id });
        if (!mine) {
          const owner = await hosts.get(hostKey);
          if (owner && owner.id !== body.id) throw new CoordError(409, 'HOST_TAKEN', 'this host and port belong to another node');
        }
      }
      if (existing && existing.hostKey && existing.hostKey !== hostKey) await hosts.delete(existing.hostKey, { id: body.id });
      if (!existing) {
        const doc = {
          _id: body.id, descriptor, roles: body.roles, hostKey, region: body.region || null,
          firstSeen: t, lastSeen: t, lastHbTs: 0, heartbeats: 0, onTime: 0, liveMs: 0, load: null,
          redeemedCount: 0n, redeemedLamports: 0n,
        };
        await nodes.insert(doc);
        return { node: doc, created: true };
      }
      const gap = t - existing.lastSeen;
      const node = await nodes.update(body.id, {
        set: { descriptor, roles: body.roles, hostKey, region: body.region || null, lastSeen: t, liveMs: Number(existing.liveMs || 0) + (gap <= config.livenessMs ? gap : 0) },
      });
      return { node, created: false };
    });
  }

  async function heartbeat({ id, ts, load, sig }) {
    const t = now();
    if (!verifyObject(id, { id, ts, load }, sig)) throw new CoordError(401, 'BAD_SIGNATURE', 'heartbeat signature does not verify');
    if (Math.abs(t - ts) > config.requestMaxSkewMs) throw new CoordError(400, 'STALE', 'heartbeat timestamp is too far from now');
    const node = await nodes.get(id);
    if (!node) throw new CoordError(404, 'NOT_REGISTERED', 'node is not registered');
    if (ts <= node.lastHbTs) throw new CoordError(409, 'REPLAY', 'heartbeat is not newer than the last one');
    const gap = Math.max(0, t - node.lastSeen);
    const onTime = node.heartbeats === 0 || gap <= config.heartbeatIntervalMs * 1.5;
    const updated = await nodes.update(id, {
      where: { lastHbTs: node.lastHbTs },
      set: { lastSeen: t, lastHbTs: ts, load, liveMs: Number(node.liveMs || 0) + (gap <= config.livenessMs ? gap : 0) },
      inc: { heartbeats: 1, onTime: onTime ? 1 : 0 },
    });
    if (!updated) throw new CoordError(409, 'REPLAY', 'a concurrent heartbeat was recorded first');
    return { live: true, nextInMs: config.heartbeatIntervalMs, reputation: reputationOf(updated, t).score };
  }

  async function get(id) { return nodes.get(id); }

  async function liveNodes(role) {
    const t = now();
    const filter = { lastSeen: { $gte: t - config.livenessMs } };
    if (role) filter.roles = role;
    return { t, rows: await nodes.find(filter, { sort: { _id: 1 }, limit: config.directoryMaxNodes }) };
  }

  // Signed directory. Clients check verifyObject(body.coordinator, body, sig) and that
  // body.coordinator is the coordinator id they pinned (shown on /api/health).
  async function directory(role) {
    const { t, rows } = await liveNodes(role);
    const body = {
      v: 1,
      ts: t,
      coordinator: identity.id,
      role: role || null,
      livenessMs: config.livenessMs,
      links: { coordinator: solscan(identity.id, config) },
      nodes: rows.map((n) => ({
        descriptor: n.descriptor,
        reputation: reputationOf(n, t).score,
        links: { id: solscan(n._id, config), payout: solscan(n.descriptor.payout, config) },
      })),
    };
    return { directory: body, sig: identity.signObject(body) };
  }

  // Public map: never host, ip, port, onion or kx.
  async function map() {
    const { t, rows } = await liveNodes(null);
    return rows.map((n) => {
      const out = { id: n._id, roles: n.roles, uptimeSeconds: Math.floor(Number(n.liveMs || 0) / 1000), reputation: reputationOf(n, t).score, link: solscan(n._id, config) };
      if (n.region) out.region = n.region;
      return out;
    });
  }

  async function onlineCounts() {
    const t = now();
    const since = { $gte: t - config.livenessMs };
    const out = { online: await nodes.count({ lastSeen: since }) };
    for (const role of ['relay', 'exit', 'gateway', 'compute']) out[role] = await nodes.count({ lastSeen: since, roles: role });
    return out;
  }

  async function recordWork(id, lamports) {
    if (lamports <= 0n) return;
    await nodes.update(id, { inc: { redeemedCount: 1n, redeemedLamports: lamports } });
  }

  async function sweep() {
    const t = now();
    const dead = await nodes.find({ lastSeen: { $lt: t - config.evictAfterMs } }, { limit: 1000 });
    let evicted = 0;
    for (const n of dead) {
      const gone = await store.transaction(async () => {
        const ok = await nodes.delete(n._id, { lastSeen: n.lastSeen });
        if (ok && n.hostKey) await hosts.delete(n.hostKey, { id: n._id });
        return ok;
      });
      if (gone) evicted += 1;
    }
    if (evicted && log) log.info('nodes.evicted', { count: evicted });
    return evicted;
  }

  return { init, register, heartbeat, get, directory, map, onlineCounts, recordWork, sweep, isLive: (n) => live(n, now()) };
}
