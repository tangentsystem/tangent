// Provisioner: tells the owner, in the logs, which wallets the service created,
// what each is for and how much SOL each needs, then watches the balances and
// carries on by itself once a wallet is funded.
//
// It never moves funds. It holds no signer and has no code path that sends a
// transaction: it only reads balances through getBalance(address). (The off grid tip sweep,
// src/coord/tip-sweep.js, is a separate part of the service.)
//
// Boot prints one block:
//   WALLETS
//     coordinator   <address>  signs the node directory. needs 0 SOL  <solscan link>
//     tip account   <address>  receives off grid tips. needs 0.0009 SOL (rent exempt minimum) <solscan link>
//     rings wallet  <address>  pays Privacy Rings fees. needs 0.05 SOL <solscan link>
// then, while a wallet is short: FUND THIS WALLET ... (at most every 5 minutes
// unless the balance changes), FUNDED ... once it is covered (and onFunded(label)
// is called so the module that needs it can start), LOW BALANCE ... hourly if it
// later drops under a quarter of its need.
import { solscan } from './config.js';

const LAMPORTS_PER_SOL = 1_000_000_000n;
// Fallback only: the service passes the live figure (getMinimumBalanceForRentExemption(0)), which on
// mainnet was 650,240 lamports on 25 November 2026 (it was 890,880 before the rent change).
const TIP_ACCOUNT_RENT_LAMPORTS = 890_880n;
const FUND_EVERY_MS = 5 * 60 * 1000;
const LOW_EVERY_MS = 60 * 60 * 1000;

export function formatSol(lamports, { roundUp = false } = {}) {
  let v = typeof lamports === 'bigint' ? lamports : BigInt(lamports || 0);
  if (v < 0n) v = 0n;
  const unit = LAMPORTS_PER_SOL / 10_000n;
  let units = v / unit;
  if (roundUp && v % unit !== 0n) units += 1n;
  const whole = units / 10_000n;
  const frac = (units % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// The wallets the service runs on, with what each needs. extra: more wallets a module reports.
export function walletList({ keys, config = {}, extra = [], tipRentLamports = null }) {
  const list = [
    { label: 'coordinator', name: 'coordinator', address: keys.coordinator.id, needLamports: 0n, purpose: 'signs the node directory, holds no funds' },
    // A Solana account must hold the rent exempt minimum (read live from the RPC when the service has
    // one) before a transfer smaller than that can land in it: until then every off grid transaction
    // carrying a small tip fails on chain.
    { label: 'tip', name: 'tip account', address: keys.tip.address, needLamports: tipRentLamports !== null && tipRentLamports !== undefined ? BigInt(tipRentLamports) : TIP_ACCOUNT_RENT_LAMPORTS, purpose: 'receives off grid transaction tips (needs the rent exempt minimum first); the service moves tips above that minimum into the Rings wallet\'s private balance by itself' },
    { label: 'rings', name: 'rings wallet', address: keys.rings.address, needLamports: BigInt(config.ringsFundingLamports ?? 50_000_000n), purpose: 'pays Privacy Rings fees for deposits and node payouts' },
  ];
  for (const w of extra || []) {
    if (!w || typeof w.address !== 'string' || typeof w.label !== 'string') continue;
    list.push({ label: w.label.slice(0, 32), name: (w.name || w.label).slice(0, 32), address: w.address, needLamports: BigInt(w.needLamports ?? 0n), purpose: String(w.purpose || '').slice(0, 120) });
  }
  return list.map((w) => ({ ...w, link: solscan(w.address, config) }));
}

export function createProvisioner({ config = {}, keys, log, getBalance = null, extra = [], onFunded = () => {}, now = Date.now, tipRentLamports = null } = {}) {
  if (!keys || !keys.coordinator) throw new Error('provision: keys are required');
  const say = (text) => { try { log.line(text); } catch { /* never stop on a broken logger */ } };
  const wallets = walletList({ keys, config, extra, tipRentLamports });
  const pollMs = Number(config.provisionPollMs) > 0 ? Number(config.provisionPollMs) : 60_000;
  const watch = !keys.ephemeral && typeof getBalance === 'function';
  const state = new Map(wallets.map((w) => [w.label, { balance: null, funded: w.needLamports === 0n, lastFundAt: null, lastFundBalance: null, lastLowAt: null, fails: 0 }]));
  let timer = null;
  let running = null;

  function printBlock() {
    const width = Math.max(...wallets.map((w) => w.name.length));
    say('WALLETS');
    for (const w of wallets) {
      say(`  ${w.name.padEnd(width)}  ${w.address}  ${w.purpose}. needs ${formatSol(w.needLamports, { roundUp: true })} SOL  ${w.link}`);
    }
    if (keys.created && keys.created.length && !keys.ephemeral) say(`  created this boot: ${keys.created.join(', ')} (saved to the database with a backup copy)`);
    if (keys.ephemeral) {
      say('  NO DATABASE: these wallets exist only for this run. Do not send funds to them. Set MONGO_URI and the service creates and keeps its own wallets.');
    } else if (!watch) {
      say('  Balances are not checked: set HELIUS_API_KEY so the service can read them.');
    }
  }

  async function pass() {
    for (const w of wallets) {
      if (w.needLamports === 0n) continue;
      const st = state.get(w.label);
      let balance;
      try {
        const b = await getBalance(w.address);
        balance = typeof b === 'bigint' ? b : BigInt(b);
        st.fails = 0;
      } catch (err) {
        st.fails += 1;
        if (st.fails === 1 || st.fails % 10 === 0) log.warn('provision.balance_unreadable', { wallet: w.label, reason: String(err && err.message ? err.message : err).slice(0, 120) });
        continue;
      }
      st.balance = balance;
      const t = now();
      if (balance < w.needLamports) {
        if (st.funded) {
          if (balance * 4n < w.needLamports && (st.lastLowAt === null || t - st.lastLowAt >= LOW_EVERY_MS)) {
            st.lastLowAt = t;
            say(`LOW BALANCE  ${w.name}  ${w.address}  has ${formatSol(balance)} SOL, top it up to ${formatSol(w.needLamports, { roundUp: true })} SOL  ${w.link}`);
          }
          continue;
        }
        const changed = st.lastFundBalance === null || st.lastFundBalance !== balance;
        if (changed || st.lastFundAt === null || t - st.lastFundAt >= FUND_EVERY_MS) {
          st.lastFundAt = t;
          st.lastFundBalance = balance;
          say(`FUND THIS WALLET  ${w.name}  ${w.address}  needs ${formatSol(w.needLamports - balance, { roundUp: true })} SOL more  has ${formatSol(balance)} SOL  (${w.purpose})  ${w.link}`);
        }
        continue;
      }
      if (!st.funded) {
        st.funded = true;
        say(`FUNDED  ${w.name}  ${w.address}  has ${formatSol(balance)} SOL, carrying on  ${w.link}`);
        try { await onFunded(w.label); } catch (err) { log.warn('provision.on_funded_failed', { wallet: w.label, reason: String(err && err.message).slice(0, 120) }); }
      }
    }
  }

  function tick() {
    if (!watch) return Promise.resolve(status());
    if (!running) {
      running = pass().catch((err) => log.warn('provision.pass_failed', { reason: String(err && err.message).slice(0, 120) })).finally(() => { running = null; });
    }
    return running.then(() => status());
  }

  function status() {
    return {
      watching: watch,
      ephemeral: Boolean(keys.ephemeral),
      wallets: wallets.map((w) => {
        const st = state.get(w.label);
        return { label: w.label, address: w.address, link: w.link, needLamports: w.needLamports.toString(), balanceLamports: st.balance === null ? null : st.balance.toString(), funded: watch ? st.funded : w.needLamports === 0n };
      }),
    };
  }

  function start() {
    printBlock();
    if (!watch || timer) return;
    tick();
    timer = setInterval(tick, pollMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (running) await running.catch(() => {});
  }

  return { start, stop, tick, status, wallets };
}
