// Pay module: Rings deposits -> wallet balances -> blind credit tokens -> anonymous accounts -> vouchers ->
// node earnings -> Rings payouts. Also withdrawals of unused wallet balance and off grid tip credits.
// See docs/pay.md for the full design, the store interface and the money invariant.
import { checkVoucher } from '../core/voucher.js';
import { verifyObject } from '../core/identity.js';
import { canonical } from '../core/canonical.js';
import { COLLECTIONS as C } from './store.js';
import { createIssuer } from './blind.js';
import { issueBody, redeemBody, withdrawBody, balanceBody } from './messages.js';
import { planDeposit, DEFAULT_MEMO_PREFIX } from './rings/memo.js';
import { isPermanent } from './rings/errors.js';
import { PayError, fail, isPubkey, toLamports, big, str, minBig, randomId, sha256Hex, addr, solscanTx } from './util.js';
import { createPayRouter } from './router.js';

export { createMemoryStore, kvFromStore, COLLECTIONS } from './store.js';
export { createRingsAdapter, createSimRings } from './rings/index.js';
export { PayError } from './util.js';

const DAY = 86400000;

export const DEFAULTS = Object.freeze({
  payDenominations: ['1000000', '10000000', '100000000', '1000000000'], // 0.001, 0.01, 0.1, 1 SOL
  blindKeyPeriodMs: 30 * DAY,
  blindKeyBits: 2048,
  challengeTtlMs: 5 * 60000,
  signedRequestMaxAgeMs: 2 * 60000,
  maxTokensPerIssue: 50,
  networkFeeBps: 0,
  payoutMinLamports: '10000000', // 0.01 SOL
  payoutMaxPerRun: 25,
  payoutMaxLamportsPerRun: '10000000000', // 10 SOL
  payoutRetryMs: 10 * 60000,
  withdrawMinLamports: '1000000', // 0.001 SOL
  tipGatewayBps: 5000,
  depositBatch: 200,
  workerLeaseMs: 15 * 60000,
  ringsMemoPrefix: DEFAULT_MEMO_PREFIX,
});

export function payConfig(config = {}) {
  const pick = (k) => (config[k] === undefined || config[k] === null || config[k] === '' ? DEFAULTS[k] : config[k]);
  const out = {
    denominations: (Array.isArray(config.payDenominations) && config.payDenominations.length ? config.payDenominations : DEFAULTS.payDenominations).map((d) => toLamports(d)),
    blindKeyPeriodMs: Number(pick('blindKeyPeriodMs')),
    blindKeyBits: Number(pick('blindKeyBits')),
    challengeTtlMs: Number(pick('challengeTtlMs')),
    signedRequestMaxAgeMs: Number(pick('signedRequestMaxAgeMs')),
    maxTokensPerIssue: Number(pick('maxTokensPerIssue')),
    networkFeeBps: BigInt(pick('networkFeeBps')),
    payoutMinLamports: toLamports(String(pick('payoutMinLamports'))),
    payoutMaxPerRun: Number(pick('payoutMaxPerRun')),
    payoutMaxLamportsPerRun: toLamports(String(pick('payoutMaxLamportsPerRun'))),
    payoutRetryMs: Number(pick('payoutRetryMs')),
    withdrawMinLamports: toLamports(String(pick('withdrawMinLamports'))),
    tipGatewayBps: BigInt(pick('tipGatewayBps')),
    depositBatch: Number(pick('depositBatch')),
    workerLeaseMs: Number(pick('workerLeaseMs')),
    ringsMemoPrefix: String(pick('ringsMemoPrefix')),
    // the network tip account: its tip sweeps into the vault back tips already credited, they credit no wallet
    tipSweepFrom: typeof config.tipSweepFrom === 'string' && config.tipSweepFrom ? config.tipSweepFrom : null,
  };
  if (out.networkFeeBps < 0n || out.networkFeeBps > 10000n) throw new Error('pay: networkFeeBps must be 0..10000');
  if (out.tipGatewayBps < 0n || out.tipGatewayBps > 10000n) throw new Error('pay: tipGatewayBps must be 0..10000');
  if (out.denominations.some((d) => d <= 0n)) throw new Error('pay: denominations must be positive');
  return out;
}

const voucherKey = (session, payer, node) => sha256Hex(canonical([session, payer, node]));

export function createPay({ store, rings, config = {}, log = () => {}, nodes = {}, isRegisteredNode, payoutAddress, now = Date.now, hooks = {} } = {}) {
  if (!store || typeof store.tx !== 'function') throw new Error('pay: store is required');
  if (!rings || typeof rings.vaultAddress !== 'function') throw new Error('pay: rings adapter is required');
  const cfg = payConfig(config);
  const say = typeof log === 'function' ? log : () => {};
  const isNode = isRegisteredNode || nodes.isRegistered || (async () => false);
  const payoutOf = payoutAddress || nodes.payoutAddress || (async () => null);
  const issuer = createIssuer({ store, denominations: cfg.denominations, periodMs: cfg.blindKeyPeriodMs, bits: cfg.blindKeyBits, log: say, now });
  const workerId = randomId(8);

  // ------------------------------------------------------------------ helpers
  function requireSig(wallet, body, sig) {
    if (!isPubkey(wallet)) fail('BAD_WALLET', 'wallet must be a Solana public key');
    if (typeof sig !== 'string' || !verifyObject(wallet, body, sig)) fail('BAD_SIGNATURE', 'signature does not verify', { status: 401 });
  }

  // Inside a unit: marks a one time challenge used. Throws when missing, foreign, used or expired.
  async function consumeChallenge(t, challenge, wallet) {
    const ch = await t.get(C.challenges, challenge);
    if (!ch || ch.wallet !== wallet) fail('BAD_CHALLENGE', 'unknown challenge', { status: 401 });
    if (ch.used) fail('CHALLENGE_USED', 'challenge already used', { status: 401 });
    if (ch.expires < now()) fail('CHALLENGE_EXPIRED', 'challenge expired', { status: 401 });
    await t.put(C.challenges, challenge, { ...ch, used: true, usedAt: now() });
  }

  async function addTo(t, coll, id, field, delta, extra = {}) {
    const doc = (await t.get(coll, id)) || {};
    const next = big(doc[field]) + delta;
    if (next < 0n) throw new Error(`pay: ${coll}/${id}.${field} would go negative`);
    const out = { ...doc, ...extra, [field]: str(next) };
    await t.put(coll, id, out);
    return out;
  }

  async function addEarnings(t, nodeId, amount) {
    const e = (await t.get(C.earnings, nodeId)) || {};
    await t.put(C.earnings, nodeId, { ...e, nodeId, balance: str(big(e.balance) + amount), earned: str(big(e.earned) + amount), paid: str(big(e.paid)), pending: str(big(e.pending)) });
  }

  async function addFee(t, amount) {
    if (amount > 0n) await addTo(t, C.fees, 'network', 'balance', amount);
  }

  // Lease so only one worker (in any process) sends payouts and withdrawals at a time.
  async function withLease(name, fn) {
    const id = 'lease:' + name;
    const got = await store.tx(async (t) => {
      const l = await t.get(C.meta, id);
      if (l && l.owner !== workerId && l.until > now()) return false;
      await t.put(C.meta, id, { owner: workerId, until: now() + cfg.workerLeaseMs });
      return true;
    });
    if (!got) return { skipped: 'busy' };
    const renew = () => store.tx(async (t) => {
      const l = await t.get(C.meta, id);
      if (l && l.owner !== workerId && l.until > now()) throw new PayError('LEASE_LOST', 'worker lease taken over');
      await t.put(C.meta, id, { owner: workerId, until: now() + cfg.workerLeaseMs });
    });
    try {
      return await fn(renew);
    } finally {
      await store.tx(async (t) => {
        const l = await t.get(C.meta, id);
        if (l && l.owner === workerId) await t.put(C.meta, id, { owner: null, until: 0 });
      }).catch(() => {});
    }
  }

  // ------------------------------------------------------------------ deposits
  function depositAddress(walletPubkey) {
    if (!isPubkey(walletPubkey)) fail('BAD_WALLET', 'wallet must be a Solana public key');
    const vault = rings.vaultAddress();
    return {
      wallet: walletPubkey,
      vault: addr(vault),
      asset: 'SOL',
      memo: cfg.ringsMemoPrefix + walletPubkey,
      // A confidential transfer from this wallet's own Rings private wallet is credited to the sender.
      // A public deposit built by depositTx() carries the memo and is credited to the wallet in the memo.
      methods: ['private-transfer-from-wallet', 'public-deposit'],
    };
  }

  // Unsigned public deposit transaction (base64) the user signs and sends from their wallet.
  async function depositTx(walletPubkey, amount) {
    if (!isPubkey(walletPubkey)) fail('BAD_WALLET', 'wallet must be a Solana public key');
    const value = toLamports(amount);
    if (value <= 0n) fail('BAD_AMOUNT', 'amount must be positive');
    if (typeof rings.buildPublicDeposit !== 'function') fail('UNAVAILABLE', 'public deposits are not available', { status: 503 });
    return rings.buildPublicDeposit({ from: walletPubkey, amount: value, creditTo: walletPubkey });
  }

  let syncing = null;
  async function syncOnce() {
    const cur = await store.get(C.meta, 'deposit_cursor');
    const cursor = cur ? cur.cursor : null;
    const page = await rings.listIncoming({ cursor, limit: cfg.depositBatch });
    const summary = { seen: (page.items || []).length, credited: 0, ignored: 0, duplicate: 0 };
    for (const item of page.items || []) {
      const plan = planDeposit(item, { prefix: cfg.ringsMemoPrefix, sweepFrom: cfg.tipSweepFrom });
      const outcome = await store.tx(async (t) => {
        if (await t.get(C.deposits, item.id)) return 'duplicate';
        const base = { from: item.from || null, asset: item.asset, amount: String(item.amount), slot: item.slot === undefined ? null : Number(item.slot), signature: item.signature || null, at: now() };
        if (plan.action !== 'credit') {
          await t.insert(C.deposits, item.id, { ...base, status: 'ignored', reason: plan.reason });
          return 'ignored';
        }
        await t.insert(C.deposits, item.id, { ...base, status: 'credited', wallet: plan.wallet, by: plan.by, credited: str(plan.amount) });
        const w = (await t.get(C.wallets, plan.wallet)) || {};
        await t.put(C.wallets, plan.wallet, { ...w, balance: str(big(w.balance) + plan.amount), deposited: str(big(w.deposited) + plan.amount) });
        return 'credited';
      });
      summary[outcome] += 1;
      if (outcome === 'credited') say('pay.deposit.credited', { id: item.id, by: plan.by });
      if (outcome === 'ignored') say('pay.deposit.ignored', { id: item.id, reason: plan.reason });
    }
    if (page.cursor !== undefined && page.cursor !== null && page.cursor !== cursor) {
      await store.tx(async (t) => {
        await t.put(C.meta, 'deposit_cursor', { cursor: page.cursor, at: now() });
      });
    }
    return summary;
  }
  function syncDeposits() {
    if (!syncing) syncing = syncOnce().finally(() => { syncing = null; });
    return syncing;
  }

  async function walletView(walletPubkey) {
    const w = await store.get(C.wallets, walletPubkey);
    return { wallet: walletPubkey, balance: str(big(w && w.balance)), deposited: str(big(w && w.deposited)) };
  }

  async function balance(walletPubkey, auth) {
    if (!isPubkey(walletPubkey)) fail('BAD_WALLET', 'wallet must be a Solana public key');
    if (auth) {
      const ts = Number(auth.ts);
      if (!Number.isFinite(ts) || Math.abs(now() - ts) > cfg.signedRequestMaxAgeMs) fail('STALE_REQUEST', 'timestamp too old', { status: 401 });
      requireSig(walletPubkey, balanceBody({ wallet: walletPubkey, ts }), auth.sig);
    }
    return walletView(walletPubkey);
  }

  // ------------------------------------------------------------------ challenges
  async function challenge(walletPubkey) {
    if (!isPubkey(walletPubkey)) fail('BAD_WALLET', 'wallet must be a Solana public key');
    const id = randomId(24);
    const expires = now() + cfg.challengeTtlMs;
    await store.tx(async (t) => {
      await t.insert(C.challenges, id, { wallet: walletPubkey, expires, used: false, at: now() });
    });
    return { challenge: id, expires: new Date(expires).toISOString() };
  }

  // ------------------------------------------------------------------ blind tokens
  async function issuerPublicKeys() {
    return issuer.publicKeys();
  }

  // Object form: { wallet, challenge, denomination, blinded, sig }.
  // Positional form (SPEC): (walletPubkey, sig, blindedMsgs, denomination, challenge).
  async function issueBlindTokens(...args) {
    const req = typeof args[0] === 'string' ? { wallet: args[0], sig: args[1], blinded: args[2], denomination: args[3], challenge: args[4] } : args[0] || {};
    const { wallet, sig, challenge: ch } = req;
    if (typeof ch !== 'string' || !ch) fail('BAD_CHALLENGE', 'challenge required', { status: 401 });
    const blinded = req.blinded;
    if (!Array.isArray(blinded) || blinded.length === 0) fail('BAD_BLINDED', 'blinded messages required');
    if (blinded.length > cfg.maxTokensPerIssue) fail('TOO_MANY', 'too many tokens in one request');
    if (blinded.some((b) => typeof b !== 'string')) fail('BAD_BLINDED', 'blinded messages must be base64url strings');
    if (new Set(blinded).size !== blinded.length) fail('BAD_BLINDED', 'duplicate blinded message');
    const denom = toLamports(String(req.denomination), 'BAD_DENOMINATION');
    requireSig(wallet, issueBody({ wallet, challenge: ch, denomination: denom.toString(), blinded }), sig);
    const key = await issuer.currentKey(denom);
    const sigs = issuer.blindSign(key, blinded); // nothing is returned unless the unit below commits
    const cost = denom * BigInt(blinded.length);
    const issuanceId = randomId();
    const after = await store.tx(async (t) => {
      await consumeChallenge(t, ch, wallet);
      const w = (await t.get(C.wallets, wallet)) || {};
      const bal = big(w.balance);
      if (bal < cost) fail('INSUFFICIENT_BALANCE', 'wallet balance too low', { status: 402, details: { balance: str(bal), needed: str(cost) } });
      await t.put(C.wallets, wallet, { ...w, balance: str(bal - cost) });
      const ks = (await t.get(C.keystats, key.keyId)) || { denomination: denom.toString(), issued: 0, redeemed: 0 };
      await t.put(C.keystats, key.keyId, { ...ks, issued: ks.issued + blinded.length });
      // The issuer's whole record of this issuance. It holds no blinded message and no signature.
      await t.insert(C.issuances, issuanceId, { wallet, keyId: key.keyId, denomination: denom.toString(), count: blinded.length, amount: str(cost), at: now() });
      return bal - cost;
    });
    return { keyId: key.keyId, denomination: denom.toString(), blindSigs: sigs.map((s) => Buffer.from(s).toString('base64url')), balance: str(after) };
  }

  // Object form: { token, accountId, sig }. Positional: (token, accountId, sig).
  async function redeemToken(...args) {
    const req = args.length >= 2 || (args[0] && args[0].keyId) ? { token: args[0], accountId: args[1], sig: args[2] } : args[0] || {};
    const { token, accountId, sig } = req;
    if (!isPubkey(accountId)) fail('BAD_ACCOUNT', 'accountId must be an ed25519 public key (base58)');
    if (!token || typeof token !== 'object') fail('BAD_TOKEN', 'token required');
    const t0 = { keyId: token.keyId, msg: token.msg, sig: token.sig };
    if (typeof sig !== 'string' || !verifyObject(accountId, redeemBody({ token: t0, accountId }), sig)) fail('BAD_SIGNATURE', 'account signature does not verify', { status: 401 });
    const { key, spentId } = await issuer.verifyToken(t0);
    const denom = key.denomination;
    const bal = await store.tx(async (t) => {
      if (await t.get(C.spent, spentId)) fail('TOKEN_SPENT', 'token already redeemed', { status: 409 });
      await t.insert(C.spent, spentId, { keyId: key.keyId, at: now() });
      const a = (await t.get(C.accounts, accountId)) || { createdAt: now() };
      const next = big(a.balance) + denom;
      await t.put(C.accounts, accountId, { ...a, balance: str(next), funded: str(big(a.funded) + denom) });
      const ks = (await t.get(C.keystats, key.keyId)) || { denomination: denom.toString(), issued: 0, redeemed: 0 };
      if (ks.redeemed + 1 > ks.issued) throw new Error('pay: more tokens redeemed than issued for key ' + key.keyId);
      await t.put(C.keystats, key.keyId, { ...ks, redeemed: ks.redeemed + 1 });
      return next;
    });
    return { accountId, credited: denom.toString(), balance: str(bal) };
  }

  async function account(accountId) {
    if (!isPubkey(accountId)) fail('BAD_ACCOUNT', 'accountId must be an ed25519 public key (base58)');
    const a = await store.get(C.accounts, accountId);
    if (!a) return null;
    return { accountId, balance: str(big(a.balance)), funded: str(big(a.funded)), spent: str(big(a.spent)) };
  }

  // ------------------------------------------------------------------ vouchers
  // -> { ok, credited, nodeCredited, fee, shortfall, partial?, reason? }
  async function redeemVoucher(voucher, { node } = {}) {
    const res = (ok, extra = {}) => ({ ok, credited: '0', nodeCredited: '0', fee: '0', shortfall: '0', ...extra });
    const chk = checkVoucher(voucher, { node, now: now() });
    if (!chk.ok) return res(false, { reason: chk.reason });
    if (!(await isNode(voucher.node))) return res(false, { reason: 'unknown node' });
    const cumulative = BigInt(voucher.cumulative);
    const id = voucherKey(voucher.session, voucher.payer, voucher.node);
    return store.tx(async (t) => {
      const hw = await t.get(C.vouchers, id);
      if (hw && hw.kind !== voucher.kind) return res(false, { reason: 'kind mismatch' });
      const paid = big(hw && hw.paid);
      if (cumulative <= paid) return res(true, { reason: 'nothing new', paidTotal: str(paid) });
      const delta = cumulative - paid;
      const a = await t.get(C.accounts, voucher.payer);
      if (!a) return res(false, { reason: 'no account', shortfall: str(delta) });
      const bal = big(a.balance);
      const credited = minBig(delta, bal);
      if (credited === 0n) return res(false, { reason: 'insufficient funds', shortfall: str(delta) });
      const fee = (credited * cfg.networkFeeBps) / 10000n;
      const nodeAmount = credited - fee;
      await t.put(C.accounts, voucher.payer, { ...a, balance: str(bal - credited), spent: str(big(a.spent) + credited) });
      await t.put(C.vouchers, id, {
        session: voucher.session,
        payer: voucher.payer,
        node: voucher.node,
        kind: voucher.kind,
        paid: str(paid + credited),
        maxCumulative: str(hw && big(hw.maxCumulative) > cumulative ? big(hw.maxCumulative) : cumulative),
        seq: Math.max(voucher.seq, (hw && hw.seq) || 0),
        updatedAt: now(),
      });
      await addEarnings(t, voucher.node, nodeAmount);
      await addFee(t, fee);
      const shortfall = delta - credited;
      return res(true, { credited: str(credited), nodeCredited: str(nodeAmount), fee: str(fee), shortfall: str(shortfall), paidTotal: str(paid + credited), ...(shortfall > 0n ? { partial: true, reason: 'insufficient funds' } : {}) });
    });
  }

  // ------------------------------------------------------------------ off grid tips
  // Called by the coordinator AFTER it verified the on chain tip transfer. id = that transaction's signature.
  // Split: network fee first (networkFeeBps), then tipGatewayBps of the rest to the gateway, the remainder shared
  // equally by the distinct registered carriers (not the gateway); any rounding dust and the share of unknown
  // carriers go to the gateway. Exactly once per id.
  async function creditTip({ id, lamports, gateway, carriers = [] } = {}) {
    if (typeof id !== 'string' || id.length < 16 || id.length > 128) fail('BAD_TIP', 'tip id (transaction signature) required');
    const total = toLamports(lamports);
    if (total <= 0n) fail('BAD_TIP', 'tip must be positive');
    if (!isPubkey(gateway) || !(await isNode(gateway))) fail('UNKNOWN_NODE', 'gateway is not a registered node', { status: 404 });
    const known = [];
    for (const c of new Set(Array.isArray(carriers) ? carriers : [])) {
      if (c !== gateway && isPubkey(c) && (await isNode(c))) known.push(c);
    }
    const fee = (total * cfg.networkFeeBps) / 10000n;
    const rest = total - fee;
    let gatewayShare = known.length ? (rest * cfg.tipGatewayBps) / 10000n : rest;
    const each = known.length ? (rest - gatewayShare) / BigInt(known.length) : 0n;
    gatewayShare = rest - each * BigInt(known.length);
    const shares = [{ nodeId: gateway, lamports: str(gatewayShare), role: 'gateway' }, ...known.map((c) => ({ nodeId: c, lamports: str(each), role: 'carrier' }))];
    return store.tx(async (t) => {
      const prior = await t.get(C.tips, id);
      if (prior) return { ok: true, duplicate: true, shares: prior.shares, fee: prior.fee };
      await t.insert(C.tips, id, { lamports: str(total), fee: str(fee), shares, at: now() });
      for (const s of shares) if (BigInt(s.lamports) > 0n) await addEarnings(t, s.nodeId, BigInt(s.lamports));
      await addFee(t, fee);
      return { ok: true, duplicate: false, shares, fee: str(fee) };
    });
  }

  // ------------------------------------------------------------------ earnings and payouts
  async function earnings(nodeId) {
    const e = await store.get(C.earnings, nodeId);
    return { nodeId, unpaid: str(big(e && e.balance)), earned: str(big(e && e.earned)), paid: str(big(e && e.paid)), pending: str(big(e && e.pending)) };
  }

  function payoutView(p) {
    return { id: p._id, nodeId: p.nodeId, to: addr(p.to), amount: p.amount, status: p.status, signature: p.signature || null, explorer: p.signature ? solscanTx(p.signature) : null, createdAt: p.createdAt, sentAt: p.sentAt || null };
  }

  async function payouts({ nodeId, status, limit = 100 } = {}) {
    const filter = {};
    if (nodeId) filter.nodeId = nodeId;
    if (status) filter.status = status;
    return (await store.find(C.payouts, filter, { sort: { createdAt: -1 }, limit })).map(payoutView);
  }

  // Sends one pending payout. The idempotency key is the payout id, so a retry after "sent but not recorded"
  // returns the first transfer instead of paying again.
  async function settlePayout(p, summary) {
    let result;
    try {
      result = await rings.sendPrivate({ to: p.to, asset: 'SOL', amount: BigInt(p.amount), memo: 'po:' + p._id, idempotencyKey: 'po:' + p._id });
    } catch (err) {
      if (isPermanent(err)) {
        await store.tx(async (t) => {
          const cur = await t.get(C.payouts, p._id);
          if (!cur || cur.status !== 'pending') return;
          await t.put(C.payouts, p._id, { ...cur, status: 'failed', error: String(err.code || err.message), failedAt: now() });
          const e = (await t.get(C.earnings, cur.nodeId)) || {};
          await t.put(C.earnings, cur.nodeId, { ...e, balance: str(big(e.balance) + BigInt(cur.amount)), pending: str(big(e.pending) - BigInt(cur.amount)), retryAt: now() + cfg.payoutRetryMs, lastError: String(err.code || err.message) });
        });
        summary.failed += 1;
        say('pay.payout.failed', { id: p._id, code: err.code });
      } else {
        await store.tx(async (t) => {
          const cur = await t.get(C.payouts, p._id);
          if (!cur || cur.status !== 'pending') return;
          await t.put(C.payouts, p._id, { ...cur, attempts: (cur.attempts || 0) + 1, lastError: String((err && (err.code || err.message)) || err) });
        });
        summary.retry += 1;
        say('pay.payout.transient', { id: p._id, code: err && err.code });
      }
      return;
    }
    await store.tx(async (t) => {
      const cur = await t.get(C.payouts, p._id);
      if (!cur || cur.status !== 'pending') return;
      await t.put(C.payouts, p._id, { ...cur, status: 'sent', signature: result.signature, slot: result.slot === undefined ? null : Number(result.slot), sentAt: now() });
      const e = (await t.get(C.earnings, cur.nodeId)) || {};
      await t.put(C.earnings, cur.nodeId, { ...e, pending: str(big(e.pending) - BigInt(cur.amount)), paid: str(big(e.paid) + BigInt(cur.amount)) });
    });
    summary.sent += 1;
  }

  async function runPayouts() {
    return withLease('payouts', async (renew) => {
      const summary = { reconciled: 0, created: 0, sent: 0, failed: 0, retry: 0, skipped: 0 };
      // 1. intents left by an earlier run (crash between intent and send, or a transient error)
      for (const p of await store.find(C.payouts, { status: 'pending' }, { sort: { createdAt: 1 } })) {
        await renew();
        summary.reconciled += 1;
        await settlePayout(p, summary);
      }
      // 2. new intents, biggest balances first, within the per run caps
      const all = await store.find(C.earnings, {});
      const due = all.filter((e) => big(e.balance) >= cfg.payoutMinLamports && !(e.retryAt && e.retryAt > now())).sort((a, b) => (big(b.balance) > big(a.balance) ? 1 : big(b.balance) < big(a.balance) ? -1 : 0));
      let budget = cfg.payoutMaxLamportsPerRun;
      let count = 0;
      for (const e of due) {
        if (count >= cfg.payoutMaxPerRun || budget < cfg.payoutMinLamports) break;
        const nodeId = e._id;
        const to = await payoutOf(nodeId);
        if (!isPubkey(to)) {
          summary.skipped += 1;
          continue;
        }
        await renew();
        const id = randomId();
        const intent = await store.tx(async (t) => {
          const cur = (await t.get(C.earnings, nodeId)) || {};
          const amount = minBig(big(cur.balance), budget);
          if (amount < cfg.payoutMinLamports) return null;
          await t.put(C.earnings, nodeId, { ...cur, balance: str(big(cur.balance) - amount), pending: str(big(cur.pending) + amount) });
          const doc = { nodeId, to, amount: str(amount), status: 'pending', createdAt: now() };
          await t.insert(C.payouts, id, doc);
          return { ...doc, _id: id };
        });
        if (!intent) continue;
        summary.created += 1;
        count += 1;
        budget -= BigInt(intent.amount);
        if (hooks.afterPayoutIntent) await hooks.afterPayoutIntent(intent); // tests: simulate a crash here
        await settlePayout(intent, summary);
      }
      return summary;
    });
  }

  // ------------------------------------------------------------------ withdrawals
  async function withdraw(req = {}) {
    const { wallet, challenge: ch, to, sig } = req;
    const isPublic = req.public === true;
    if (typeof ch !== 'string' || !ch) fail('BAD_CHALLENGE', 'challenge required', { status: 401 });
    if (!isPubkey(to)) fail('BAD_ADDRESS', 'to must be a Solana address');
    const amount = toLamports(String(req.amount));
    requireSig(wallet, withdrawBody({ wallet, challenge: ch, to, amount: amount.toString(), public: isPublic }), sig);
    if (amount < cfg.withdrawMinLamports || amount <= 0n) fail('BAD_AMOUNT', 'amount below the minimum withdrawal', { details: { min: str(cfg.withdrawMinLamports) } });
    const id = randomId();
    const left = await store.tx(async (t) => {
      await consumeChallenge(t, ch, wallet);
      const w = (await t.get(C.wallets, wallet)) || {};
      const bal = big(w.balance);
      if (bal < amount) fail('INSUFFICIENT_BALANCE', 'wallet balance too low', { status: 402, details: { balance: str(bal) } });
      await t.put(C.wallets, wallet, { ...w, balance: str(bal - amount) });
      await t.insert(C.withdrawals, id, { wallet, to, amount: str(amount), public: isPublic, status: 'pending', createdAt: now() });
      return bal - amount;
    });
    return { id, status: 'pending', amount: str(amount), to: addr(to), balance: str(left) };
  }

  function withdrawalView(w) {
    return { id: w._id, to: addr(w.to), amount: w.amount, public: Boolean(w.public), status: w.status, signature: w.signature || null, explorer: w.signature ? solscanTx(w.signature) : null, createdAt: w.createdAt };
  }

  async function withdrawal(id) {
    if (typeof id !== 'string' || !id) return null;
    const w = await store.get(C.withdrawals, id);
    return w ? withdrawalView(w) : null;
  }

  async function processWithdrawals() {
    return withLease('withdrawals', async (renew) => {
      const summary = { sent: 0, refunded: 0, retry: 0 };
      for (const w of await store.find(C.withdrawals, { status: 'pending' }, { sort: { createdAt: 1 } })) {
        await renew();
        const args = { to: w.to, asset: 'SOL', amount: BigInt(w.amount), memo: 'wd:' + w._id, idempotencyKey: 'wd:' + w._id };
        let result;
        try {
          result = w.public ? await rings.withdrawPublic(args) : await rings.sendPrivate(args);
        } catch (err) {
          if (isPermanent(err)) {
            await store.tx(async (t) => {
              const cur = await t.get(C.withdrawals, w._id);
              if (!cur || cur.status !== 'pending') return;
              await t.put(C.withdrawals, w._id, { ...cur, status: 'refunded', error: String(err.code || err.message), refundedAt: now() });
              const wl = (await t.get(C.wallets, cur.wallet)) || {};
              await t.put(C.wallets, cur.wallet, { ...wl, balance: str(big(wl.balance) + BigInt(cur.amount)) });
            });
            summary.refunded += 1;
          } else {
            await store.tx(async (t) => {
              const cur = await t.get(C.withdrawals, w._id);
              if (!cur || cur.status !== 'pending') return;
              await t.put(C.withdrawals, w._id, { ...cur, attempts: (cur.attempts || 0) + 1, lastError: String((err && (err.code || err.message)) || err) });
            });
            summary.retry += 1;
          }
          continue;
        }
        await store.tx(async (t) => {
          const cur = await t.get(C.withdrawals, w._id);
          if (!cur || cur.status !== 'pending') return;
          await t.put(C.withdrawals, w._id, { ...cur, status: 'sent', signature: result.signature, slot: result.slot === undefined ? null : Number(result.slot), sentAt: now() });
        });
        summary.sent += 1;
      }
      return summary;
    });
  }

  // ------------------------------------------------------------------ readiness and the worker tick
  let lastFundingLog = 0;
  async function ready() {
    if (typeof rings.ensureReady !== 'function') return { status: 'ready' };
    const r = await rings.ensureReady();
    if (r.status === 'needs_funding' && now() - lastFundingLog > 10 * 60000) {
      lastFundingLog = now();
      say('pay.rings.needs_funding', { address: r.address, explorer: addr(r.address).explorer, haveLamports: r.haveLamports, needLamports: r.needLamports, why: 'public SOL for the Rings wallet registration and transaction fees' });
    }
    return r;
  }

  // One pass of the background work. Sends nothing until the Rings wallet is ready.
  async function tick() {
    const r = await ready();
    if (r.status !== 'ready') return { ready: r };
    const out = { ready: r };
    for (const [name, fn] of [['deposits', syncDeposits], ['withdrawals', processWithdrawals], ['payouts', runPayouts]]) {
      try {
        out[name] = await fn();
      } catch (err) {
        out[name] = { error: String((err && (err.code || err.message)) || err) };
        say('pay.tick.error', { stage: name, error: out[name].error });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ totals (money invariant, stats)
  async function totals() {
    const sum = (rows, f) => rows.reduce((a, r) => a + big(r[f]), 0n);
    const deposits = (await store.find(C.deposits, { status: 'credited' })).reduce((a, d) => a + big(d.credited), 0n);
    const tips = sum(await store.find(C.tips, {}), 'lamports');
    const wallets = sum(await store.find(C.wallets, {}), 'balance');
    const tokens = (await store.find(C.keystats, {})).reduce((a, k) => a + BigInt(k.issued - k.redeemed) * BigInt(k.denomination), 0n);
    const accounts = sum(await store.find(C.accounts, {}), 'balance');
    const earningsRows = await store.find(C.earnings, {});
    const unpaid = sum(earningsRows, 'balance');
    const payoutRows = await store.find(C.payouts, {});
    const payoutsPending = payoutRows.filter((p) => p.status === 'pending').reduce((a, p) => a + big(p.amount), 0n);
    const payoutsSent = payoutRows.filter((p) => p.status === 'sent').reduce((a, p) => a + big(p.amount), 0n);
    const wdRows = await store.find(C.withdrawals, {});
    const withdrawalsPending = wdRows.filter((w) => w.status === 'pending').reduce((a, w) => a + big(w.amount), 0n);
    const withdrawalsSent = wdRows.filter((w) => w.status === 'sent').reduce((a, w) => a + big(w.amount), 0n);
    const feeDoc = await store.get(C.fees, 'network');
    const fees = big(feeDoc && feeDoc.balance);
    const inflow = deposits + tips;
    const held = wallets + tokens + accounts + unpaid + payoutsPending + payoutsSent + withdrawalsPending + withdrawalsSent + fees;
    const parts = { deposits, tips, wallets, tokens, accounts, unpaid, payoutsPending, payoutsSent, withdrawalsPending, withdrawalsSent, fees };
    return { ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, str(v)])), balanced: inflow === held };
  }

  const api = {
    config: cfg,
    rings,
    depositAddress,
    depositTx,
    syncDeposits,
    balance,
    challenge,
    issuerPublicKeys,
    issueBlindTokens,
    redeemToken,
    account,
    redeemVoucher,
    creditTip,
    earnings,
    payouts,
    runPayouts,
    withdraw,
    withdrawal,
    processWithdrawals,
    ready,
    tick,
    totals,
    // True when deposit addresses may be shown to people: a real Rings adapter, or a sim explicitly allowed (tests).
    live: rings.mode === 'real' || config.payExposeSim === true,
  };
  api.router = createPayRouter(api);
  return api;
}
