// HTTP client of the coordinator, used by the node daemon and the client CLI.
// Signed requests are built here (register, heartbeat, voucher redemption, claims).
// The directory is checked against a pinned coordinator id before anything uses it.
import { checkDescriptor, verifyObject } from '../core/index.js';

export class CoordError extends Error {
  constructor(status, code, message, body) {
    super(message || code || `coordinator answered ${status}`);
    this.name = 'CoordError';
    this.status = status;
    this.code = code || null;
    this.body = body || null;
    // 0 = no answer at all (network); 5xx and 429 are worth retrying
    this.transient = status === 0 || status === 429 || status >= 500;
  }
}

export function createCoordinatorClient({ url, identity = null, fetch: f = globalThis.fetch, timeoutMs = 10_000, coordinatorId = null } = {}) {
  if (!url) throw new Error('coordinator: url is required');
  const base = String(url).replace(/\/+$/, '');
  let pinned = coordinatorId || null;

  async function call(method, path, body) {
    let res;
    try {
      res = await f(base + path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new CoordError(0, 'UNREACHABLE', `coordinator unreachable: ${String(err && err.message).slice(0, 120)}`);
    }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    if (!res.ok) throw new CoordError(res.status, json && json.error, (json && json.message) || `coordinator answered ${res.status}`, json);
    return json;
  }
  const get = (p) => call('GET', p);
  const post = (p, b) => call('POST', p, b);

  function signed(fields) {
    if (!identity) throw new Error('coordinator: this call needs an identity');
    return { ...fields, sig: identity.signObject(fields) };
  }

  async function health() {
    const h = await get('/api/health');
    if (!pinned && h && h.network && h.network.coordinator) pinned = h.network.coordinator;
    return h;
  }

  // -> verified descriptors (each one's own signature checked) of live nodes
  async function directory({ role, maxAgeMs = 6 * 3600_000 } = {}) {
    if (!pinned) await health();
    const body = await get('/api/directory' + (role ? `?role=${encodeURIComponent(role)}` : ''));
    if (!body || !body.directory || !verifyObject(pinned, body.directory, body.sig)) throw new Error('directory signature does not verify against the pinned coordinator');
    if (body.directory.coordinator !== pinned) throw new Error('directory names another coordinator');
    const out = [];
    for (const n of body.directory.nodes || []) {
      const d = n && n.descriptor;
      if (d && checkDescriptor(d, { maxAgeMs }).ok) out.push(d);
    }
    return out;
  }

  return {
    base,
    get coordinatorId() { return pinned; },
    health,
    directory,
    map: () => get('/api/map'),
    stats: () => get('/api/stats'),
    earnings: (nodeId) => get(`/api/nodes/${encodeURIComponent(nodeId)}/earnings`),
    register: (descriptor) => post('/api/nodes/register', descriptor),
    heartbeat: (load = 0) => post('/api/nodes/heartbeat', signed({ id: identity.id, ts: Date.now(), load: Math.max(0, Math.min(1, Number(load) || 0)) })),
    redeem: (voucher) => post('/api/vouchers/redeem', signed({ node: identity.id, ts: Date.now(), voucher })),
    claim: (claim) => post('/api/offgrid/claim', claim),
    pay: {
      keys: () => get('/api/pay/keys'),
      challenge: (wallet) => post('/api/pay/challenge', { wallet }),
      issue: (req) => post('/api/pay/issue', req),
      redeem: (req) => post('/api/pay/redeem', req),
      account: async (id) => {
        try { return await get(`/api/pay/account/${encodeURIComponent(id)}`); } catch (err) { if (err.status === 404) return null; throw err; }
      },
      balance: (req) => post('/api/pay/balance', req),
      deposit: (wallet) => get(`/api/pay/deposit/${encodeURIComponent(wallet)}`),
      withdraw: (req) => post('/api/pay/withdraw', req),
      withdrawal: async (id) => {
        try { return await get(`/api/pay/withdraw/${encodeURIComponent(id)}`); } catch (err) { if (err.status === 404) return null; throw err; }
      },
    },
  };
}
