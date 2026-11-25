// Where this node's earnings are paid. Payouts are private Privacy Rings transfers
// (docs/pay.md), so the payout address must have a registered Rings private wallet,
// otherwise every payout fails and goes back to earnings.
//
//   --payout <address> given   the operator's own wallet; the node cannot check its
//                              Rings registration without its key, so it says so
//   no --payout                the node keeps its own payout key (insert only, with a
//                              backup) and, when it has a Solana RPC (HELIUS_API_KEY or
//                              a Helius endpoint), lets the Rings adapter register that
//                              wallet once it holds the registration fee. It logs the
//                              address and the lamports it needs. Without an RPC it
//                              logs exactly what is missing. It never guesses.
import path from 'node:path';
import fs from 'node:fs/promises';
import { unb58 } from '../core/index.js';

// Small file backed key value store for the Rings adapter's exactly once records.
export async function createFileKv(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = (ns, key) => path.join(dir, `${String(ns).replace(/[^a-z0-9_-]/gi, '_')}--${String(key).replace(/[^a-z0-9_-]/gi, '_')}.json`);
  return {
    async kvGet(ns, key) { try { return JSON.parse(await fs.readFile(file(ns, key), 'utf8')); } catch { return null; } },
    async kvSet(ns, key, value) {
      const f = file(ns, key);
      const tmp = f + '.' + process.pid + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(tmp, f);
    },
  };
}

export async function resolvePayout({ keystore, dataDir, payout = null, heliusApiKey = '', ringsEndpoint = '', cluster = 'mainnet', log = () => {}, ringsFactory = null } = {}) {
  if (payout) {
    log('warn', 'payout.external', {
      address: payout,
      explorer: `https://solscan.io/account/${payout}`,
      note: 'payouts are private Privacy Rings transfers: this address must have a registered Rings private wallet or payouts fail and return to earnings',
    });
    return { address: payout, own: false, status: 'unchecked', check: async () => ({ status: 'unchecked' }) };
  }
  const { row, created } = await keystore.ensure('payout');
  const address = row.publicKey;
  if (created) log('info', 'payout.key_created', { address, explorer: `https://solscan.io/account/${address}`, backup: 'backups/ folder of the node data' });
  const canCheck = Boolean(heliusApiKey || ringsEndpoint);
  let rings = null;
  let last = { status: canCheck ? 'unknown' : 'no_rpc' };

  async function check() {
    if (!canCheck) {
      last = { status: 'no_rpc' };
      log('warn', 'payout.not_registered', {
        address,
        explorer: `https://solscan.io/account/${address}`,
        missing: 'a Solana RPC to register this payout wallet with Privacy Rings',
        fix: 'start the node with HELIUS_API_KEY set and fund this address with about 0.003 SOL so it registers itself, or pass --payout with a wallet that is already registered with Privacy Rings',
        effect: 'until then every payout to this node fails and stays in its earnings',
      });
      return last;
    }
    try {
      if (!rings) {
        const make = ringsFactory || (await import('../pay/rings/real.js')).createRealRings;
        rings = make({ ringsSeed: unb58(row.secret), heliusApiKey, ringsEndpoint: ringsEndpoint || undefined, ringsNetwork: cluster === 'devnet' ? 'devnet' : 'mainnet' }, { storage: await createFileKv(path.join(dataDir, 'rings-kv')) });
      }
      last = await rings.ensureReady();
    } catch (err) {
      last = { status: 'error', message: String(err && err.message).slice(0, 160) };
    }
    if (last.status === 'ready') log('info', 'payout.ready', { address, explorer: `https://solscan.io/account/${address}` });
    else if (last.status === 'needs_funding') {
      log('warn', 'payout.fund_this_wallet', {
        address, explorer: `https://solscan.io/account/${address}`,
        haveLamports: String(last.haveLamports), needLamports: String(last.needLamports),
        why: 'one time Privacy Rings registration so this node can receive payouts',
      });
    } else log('warn', 'payout.check_failed', { address, reason: last.message || last.status });
    return last;
  }
  return { address, own: true, get status() { return last.status; }, check };
}
