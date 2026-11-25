// The app's wallet: one local key (created once, insert only, backed up in <data>/backups by
// the repo keystore) that holds balance at the coordinator after a Privacy Rings deposit.
// Credit for nodes is bought from it as blind tokens (src/node/credit.js). One credit
// object is shared by the private internet and the computers, because it keeps track of
// which throwaway account pays which node.
import path from 'node:path';
import fs from 'node:fs/promises';
import { createKeystore } from '../../src/node/keystore.js';
import { createCredit } from '../../src/node/credit.js';
import { checkWithdrawArgs, requestWithdrawal, followWithdrawal } from '../../src/node/withdraw.js';
import { solString, parseSol } from './format.js';

const explorer = (a) => `https://solscan.io/account/${a}`;

export function createWallet({ coord, dataDir, log = () => {}, emit = () => {} }) {
  let creditP = null;
  let keystoreP = null;
  const withdrawals = new Map();
  let lastBalance = null;

  function keystore() {
    if (!keystoreP) keystoreP = (async () => { await fs.mkdir(dataDir, { recursive: true, mode: 0o700 }); return createKeystore({ dir: dataDir }); })();
    return keystoreP;
  }
  function credit() {
    if (!creditP) {
      creditP = (async () => createCredit({ coord, keystore: await keystore(), dir: dataDir, log }))();
      creditP.catch(() => { creditP = null; });
    }
    return creditP;
  }

  async function info() {
    const c = await credit();
    return { address: c.wallet.id, explorer: explorer(c.wallet.id) };
  }

  // -> { address, walletLamports|null, creditLamports|null, tokenLamports|null, canPay }
  async function balance() {
    const c = await credit();
    const out = { address: c.wallet.id, explorer: explorer(c.wallet.id), walletLamports: null, creditLamports: null, tokenLamports: null, canPay: false };
    try { const b = await c.walletBalance(); out.walletLamports = String(b.balance ?? '0'); } catch (err) { out.walletError = err.code || 'unreachable'; }
    try { out.creditLamports = (await c.balance()).lamports; } catch { /* shown as unknown */ }
    try { out.tokenLamports = (await c.tokenLamports()).toString(); } catch { /* no issuing key */ }
    if (out.walletLamports !== null && out.tokenLamports !== null) out.canPay = BigInt(out.walletLamports) >= BigInt(out.tokenLamports);
    out.wallet = out.walletLamports === null ? null : solString(out.walletLamports);
    out.credit = out.creditLamports === null ? null : solString(out.creditLamports);
    const key = `${out.walletLamports}|${out.creditLamports}`;
    if (key !== lastBalance) { lastBalance = key; emit('wallet', out); }
    return out;
  }

  // Where to send SOL through Privacy Rings so it lands in this wallet.
  async function deposit() {
    const c = await credit();
    try {
      const d = await coord.pay.deposit(c.wallet.id);
      return {
        available: true,
        wallet: d.wallet,
        address: d.vault && d.vault.address ? d.vault.address : null,
        explorer: d.vault && d.vault.explorer ? d.vault.explorer : null,
        memo: d.memo || null,
        asset: d.asset || 'SOL',
        methods: d.methods || [],
      };
    } catch (err) {
      if (err && (err.status === 503 || err.code === 'RINGS_NOT_CONFIGURED' || err.code === 'NOT_CONFIGURED')) return { available: false, reason: 'closed' };
      if (err && err.status === 0) return { available: false, reason: 'unreachable' };
      throw err;
    }
  }

  // { to, amount (SOL text) | lamports, public } -> accepted withdrawal; followed in the background
  async function withdraw({ to, amount, lamports, public: isPublic = false } = {}) {
    const value = lamports !== undefined ? BigInt(lamports) : parseSol(amount);
    const args = checkWithdrawArgs({ to: String(to || '').trim(), lamports: value.toString(), public: isPublic === true });
    const c = await credit();
    let accepted;
    try {
      accepted = await requestWithdrawal({ coord, wallet: c.wallet, to: args.to, amount: args.amount, public: args.public });
    } catch (err) {
      const e = new Error(err.code === 'INSUFFICIENT_BALANCE' ? 'The wallet balance is lower than that amount.'
        : err.code === 'BAD_AMOUNT' ? `The smallest withdrawal is ${solString((err.body && err.body.details && err.body.details.min) || 0)} SOL.`
          : err.status === 503 ? 'Withdrawals are closed right now.' : 'The withdrawal was not accepted.');
      e.code = err.code || 'FAILED';
      throw e;
    }
    const w = { id: accepted.id, to: args.to, lamports: args.amount, amount: solString(args.amount), public: args.public, status: accepted.status || 'pending', at: Date.now(), signature: null, explorer: null };
    withdrawals.set(w.id, w);
    emit('withdrawal', { ...w });
    log('info', 'wallet.withdraw_accepted', { id: w.id, lamports: w.lamports, public: w.public });
    followWithdrawal({ coord, id: w.id, timeoutMs: 15 * 60_000, everyMs: 3000, onUpdate: (u) => {
      Object.assign(w, { status: u.status, signature: u.signature || null, explorer: u.explorer || null });
      emit('withdrawal', { ...w });
    } }).catch((err) => log('warn', 'wallet.withdraw_follow_failed', { id: w.id, reason: err.message })).finally(() => balance().catch(() => {}));
    return { ...w };
  }

  return {
    credit,
    keystore,
    info,
    balance,
    deposit,
    withdraw,
    withdrawals: () => [...withdrawals.values()].sort((a, b) => b.at - a.at).map((w) => ({ ...w })),
    backupsDir: () => path.join(dataDir, 'backups'),
  };
}
