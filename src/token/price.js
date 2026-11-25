// SOL/USD for display. CoinGecko first, then Pyth as fallback, cached briefly. Never invents a
// value: when every source fails and the last good value is older than maxStaleMs, get() returns null.
//
// Pyth: Hermes (hermes.pyth.network) answers 401 without an API key since the Pyth Core upgrade of
// 26 August 2026 (seen live from the build workspace on 25 November 2026). So the fallback reads
// Pyth's on-chain SOL/USD price feed account on Solana instead, through the service's own RPC
// connection: the sponsored push feed account (shard 0) owned by the Pyth receiver program, a
// PriceUpdateV2 account. Checked live on mainnet: owner, feed id, Full verification, fresh price.
export const PYTH_SOL_USD_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
export const PYTH_SOL_USD_ACCOUNT = '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE';
export const PYTH_RECEIVER_PROGRAM = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';
export const PYTH_MAX_AGE_SEC = 300;
export const GECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

async function getJson(fetchFn, url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r || !r.ok) throw new Error(`status ${r && r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function good(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1e7;
}

export async function fromGecko(fetchFn, timeoutMs = 4000) {
  const j = await getJson(fetchFn, GECKO_URL, timeoutMs);
  const v = Number(j && j.solana && j.solana.usd);
  if (!good(v)) throw new Error('bad coingecko price');
  return v;
}

// Decodes a Pyth PriceUpdateV2 account (Anchor): 8 byte discriminator, write authority (32),
// verification level (enum: 0 Partial { num_signatures: u8 } | 1 Full), then the price message:
// feed id (32), price i64, conf u64, exponent i32, publish time i64, ...
export function decodePythPriceUpdate(data) {
  const d = Buffer.from(data);
  let o = 8 + 32;
  if (d.length < o + 2) throw new Error('pyth account too short');
  const level = d[o];
  o += level === 0 ? 2 : 1;
  if (level !== 0 && level !== 1) throw new Error('pyth account has an unknown verification level');
  if (d.length < o + 32 + 8 + 8 + 4 + 8) throw new Error('pyth account too short');
  const feedId = d.subarray(o, o + 32).toString('hex'); o += 32;
  const price = d.readBigInt64LE(o); o += 8;
  const conf = d.readBigUInt64LE(o); o += 8;
  const exponent = d.readInt32LE(o); o += 4;
  const publishTime = Number(d.readBigInt64LE(o));
  return { verification: level === 1 ? 'full' : 'partial', feedId, price, conf, exponent, publishTime };
}

// SOL/USD from Pyth's on-chain feed account. connection: a web3.js Connection (getAccountInfo).
export async function fromPyth(connection, { now = Date.now, maxAgeSec = PYTH_MAX_AGE_SEC } = {}) {
  if (!connection || typeof connection.getAccountInfo !== 'function') throw new Error('no solana connection for pyth');
  const { PublicKey } = await import('@solana/web3.js');
  const info = await connection.getAccountInfo(new PublicKey(PYTH_SOL_USD_ACCOUNT), 'confirmed');
  if (!info) throw new Error('pyth feed account not found');
  if (info.owner.toBase58() !== PYTH_RECEIVER_PROGRAM) throw new Error('pyth feed account has another owner');
  const u = decodePythPriceUpdate(info.data);
  if (u.feedId !== PYTH_SOL_USD_ID) throw new Error('pyth account holds another feed');
  if (u.verification !== 'full') throw new Error('pyth price is not fully verified');
  const age = Math.floor(now() / 1000) - u.publishTime;
  if (age > maxAgeSec) throw new Error(`pyth price is ${age} s old`);
  const v = Number(u.price) * 10 ** u.exponent;
  if (!good(v)) throw new Error('bad pyth price');
  return v;
}

/**
 * createSolUsd({ fetch, connection, now, ttlMs, maxStaleMs, log }) -> { get() -> { solUsd, source, updatedAt } | null }
 * connection is only needed for the Pyth fallback; without one only CoinGecko is asked.
 */
export function createSolUsd({ fetch: fetchFn = globalThis.fetch, connection = null, now = Date.now, ttlMs = 30_000, maxStaleMs = 10 * 60_000, log = console } = {}) {
  let last = null;
  let checkedAt = null;
  let inflight = null;

  async function refresh() {
    const errs = [];
    const sources = [['coingecko', () => fromGecko(fetchFn)], ['pyth', () => fromPyth(connection, { now })]];
    for (const [name, src] of sources) {
      try {
        const solUsd = await src();
        last = { solUsd, source: name, updatedAt: now() };
        return;
      } catch (err) {
        errs.push(name + ': ' + (err && err.message));
      }
    }
    if (log && log.warn) log.warn('[token] SOL/USD unavailable (' + errs.join(', ') + ')');
  }

  async function get() {
    const t = now();
    if (checkedAt === null || t - checkedAt >= ttlMs || t < checkedAt) {
      if (!inflight) {
        inflight = refresh().catch(() => {}).finally(() => {
          checkedAt = now();
          inflight = null;
        });
      }
      await inflight;
    }
    if (!last) return null;
    if (now() - last.updatedAt > maxStaleMs) return null;
    return { ...last };
  }

  return { get };
}
