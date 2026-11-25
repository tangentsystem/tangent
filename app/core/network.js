// What the Network view and the token block read from the coordinator.
const ROLE_ORDER = ['exit', 'relay', 'compute', 'gateway'];

export function createNetworkInfo({ coord, fetch: f = globalThis.fetch, timeoutMs = 8000 }) {
  async function getJson(p) {
    const r = await f(coord.base + p, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!r.ok) { const e = new Error(`coordinator answered ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }

  // Live nodes: what each one does and where it is. Addresses are never shown.
  async function nodes() {
    const dir = await coord.directory();
    let map = [];
    try { map = (await coord.map()).nodes || []; } catch { map = []; }
    const byId = new Map(map.map((m) => [m.id, m]));
    return dir.map((d) => {
      const m = byId.get(d.id) || {};
      const roles = [...new Set(d.roles)].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
      return {
        id: d.id,
        roles,
        region: m.region || d.region || null,
        link: m.link || `https://solscan.io/account/${d.id}`,
        prices: d.prices || {},
      };
    });
  }

  // The token block: only when the coordinator reports both a symbol and a contract address,
  // the same rule the site uses (src/web/index.js tokenBlock).
  async function token() {
    try {
      const t = await getJson('/api/token');
      if (!t || !t.configured || !t.ca || !t.symbol) return null;
      const ca = String(t.ca);
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return null;
      const buyUrl = typeof t.buyUrl === 'string' && /^https:\/\//.test(t.buyUrl) ? t.buyUrl : null;
      return { symbol: String(t.symbol).slice(0, 16), ca, buyUrl, explorer: `https://solscan.io/token/${ca}` };
    } catch { return null; }
  }

  return { nodes, token };
}
