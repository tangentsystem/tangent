// Anonymous credit for paying nodes (client CLI, MCP payer, and a node's own egress).
//
//   wallet balance --(blind tokens)--> throwaway credit accounts, one per node
//
// The wallet (a local ed25519 key) holds balance at the coordinator after a Privacy
// Rings deposit. Credit is bought as blind signed tokens (RFC 9474, src/pay/client.js),
// unblinded here, and each token is redeemed into a fresh throwaway identity. Every
// node gets its own throwaway identity, so the hops of one circuit cannot be linked by
// payer. identityFor(nodeId) is what src/relay's client and src/compute's payer call.
//
// Money safety on a local machine:
//   - throwaway account keys are kept insert only with a backup (keystore), because
//     the credit on them is real value
//   - blinding state is saved before the issue call, unblinded tokens are saved before
//     redemption, and both are deleted only after the step that consumed them
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createIdentity, unb58 } from '../core/index.js';
import { prepareTokens, finalizeTokens, issueRequest, redeemRequest, balanceRequest } from '../pay/client.js';
import { ed25519Key, checkEd25519 } from './keystore.js';

const labelFor = (accountId) => 'acct-' + createHash('sha256').update(accountId).digest('hex').slice(0, 40);

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

export async function createCredit({ coord, keystore, dir, denomination = null, log = () => {} } = {}) {
  if (!coord || !keystore || !dir) throw new Error('credit: coord, keystore and dir are required');
  const pendingDir = path.join(dir, 'credit', 'pending');
  const tokensDir = path.join(dir, 'credit', 'tokens');
  await fs.mkdir(pendingDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(tokensDir, { recursive: true, mode: 0o700 });

  const { row: walletRow, created: walletCreated } = await keystore.ensure('wallet');
  const wallet = createIdentity(unb58(walletRow.secret));
  if (walletCreated) log('info', 'credit.wallet_created', { wallet: wallet.id });

  // Every throwaway account ever made, and the one each node is paid from now (the newest).
  // Older accounts are kept (their keys are insert only) and still pay what was started on them.
  const all = []; // { node, identity, gen, at }
  const byNode = new Map(); // nodeId -> identity of the current account
  const rows = [];
  for (const row of await keystore.list('acct-')) {
    if (!checkEd25519(row)) throw new Error('credit: a saved account key does not check out');
    const node = row.meta && row.meta.node;
    if (node) rows.push({ node, identity: createIdentity(unb58(row.secret)), gen: Number(row.meta.gen) || 0, at: Date.parse(row.createdAt) || 0 });
  }
  rows.sort((a, b) => a.gen - b.gen || a.at - b.at);
  for (const r of rows) { all.push(r); byNode.set(r.node, r.identity); }
  const genOf = (nodeId) => all.filter((r) => r.node === nodeId).reduce((m, r) => Math.max(m, r.gen), 0);
  let shortHandler = null;
  const funding = new Map(); // nodeId -> promise

  async function issuingKey() {
    const { keys } = await coord.pay.keys();
    const issuing = (keys || []).filter((k) => k.issues);
    if (!issuing.length) throw new Error('credit: the coordinator issues no credit tokens');
    if (denomination) {
      const k = issuing.find((x) => String(x.denomination) === String(denomination));
      if (!k) throw new Error(`credit: no issuing key for denomination ${denomination}`);
      return k;
    }
    return issuing.sort((a, b) => (BigInt(a.denomination) < BigInt(b.denomination) ? -1 : 1))[0];
  }

  // Buy `count` tokens from the wallet balance. -> token file paths
  async function buyTokens(count) {
    const key = await issuingKey();
    const { pending, blinded } = await prepareTokens(key, count);
    const pendingFile = path.join(pendingDir, `${Date.now()}-${randomBytes(6).toString('hex')}.json`);
    await writeJson(pendingFile, { key, pending });
    const { challenge } = await coord.pay.challenge(wallet.id);
    let res;
    try {
      res = await coord.pay.issue(issueRequest(wallet, { challenge, denomination: String(key.denomination), blinded }));
    } catch (err) {
      // nothing was signed, so nothing was paid: the blinding state is useless now
      if (err && err.status && err.status < 500) await fs.rm(pendingFile, { force: true });
      throw err;
    }
    const tokens = await finalizeTokens(key, pending, res.blindSigs);
    const files = [];
    for (const t of tokens) {
      const file = path.join(tokensDir, createHash('sha256').update(t.msg).digest('hex').slice(0, 32) + '.json');
      await writeJson(file, t);
      files.push(file);
    }
    await fs.rm(pendingFile, { force: true });
    return files;
  }

  async function redeemFile(file, account) {
    const token = JSON.parse(await fs.readFile(file, 'utf8'));
    try {
      const r = await coord.pay.redeem(redeemRequest(token, account));
      await fs.rm(file, { force: true });
      return r;
    } catch (err) {
      if (err && err.status === 409) { await fs.rm(file, { force: true }); return null; } // already spent
      throw err;
    }
  }

  // A new throwaway key for a node, saved insert only with its backup. It becomes the node's
  // current account only once the caller has put credit on it (see adopt).
  async function newAccount(nodeId) {
    const k = ed25519Key();
    const gen = genOf(nodeId) + 1;
    const { row } = await keystore.insert(labelFor(k.publicKey), { ...k, meta: { node: nodeId, gen } }, { check: checkEd25519 });
    return { node: nodeId, identity: createIdentity(unb58(row.secret)), gen, at: Date.parse(row.createdAt) || Date.now() };
  }
  function adopt(entry) {
    all.push(entry);
    byNode.set(entry.node, entry.identity);
  }

  async function leftoverTokens() {
    return (await fs.readdir(tokensDir).catch(() => [])).filter((n) => n.endsWith('.json')).map((n) => path.join(tokensDir, n));
  }

  // Fund an account for each node that has none (tokensEach tokens per node).
  async function fund(nodeIds, { tokensEach = 1 } = {}) {
    const todo = [...new Set(nodeIds)].filter((id) => !byNode.has(id));
    if (!todo.length) return [];
    const files = await leftoverTokens();
    const need = todo.length * tokensEach - files.length;
    if (need > 0) files.push(...(await buyTokens(need)));
    const out = [];
    for (const nodeId of todo) {
      const entry = await newAccount(nodeId);
      for (let i = 0; i < tokensEach; i++) await redeemFile(files.shift(), entry.identity);
      adopt(entry);
      out.push({ node: nodeId, account: entry.identity.id });
    }
    return out;
  }

  // More credit for a node that already has an account.
  //   fresh: true (default)  a new throwaway account gets the tokens and pays this node from now on.
  //                          Nothing ties it to the old one: the more private choice.
  //   fresh: false           the tokens go onto the account the node already knows. Payments already
  //                          running on that account (an open circuit, a rented computer) carry on.
  // A node with no account yet is funded as by fund().
  async function topUp(nodeId, count = 1, { fresh = true } = {}) {
    if (!Number.isInteger(count) || count < 1) throw new Error('credit: top up count must be a positive whole number');
    const current = byNode.get(nodeId);
    if (!current) return (await fund([nodeId], { tokensEach: count })).map((r) => ({ ...r, fresh: true }));
    const files = await leftoverTokens();
    if (files.length < count) files.push(...(await buyTokens(count - files.length)));
    if (fresh) {
      const entry = await newAccount(nodeId);
      for (let i = 0; i < count; i++) await redeemFile(files.shift(), entry.identity);
      adopt(entry);
      return [{ node: nodeId, account: entry.identity.id, previous: current.id, fresh: true }];
    }
    for (let i = 0; i < count; i++) await redeemFile(files.shift(), current);
    return [{ node: nodeId, account: current.id, fresh: false }];
  }

  // Value of one token of the denomination this credit buys, in lamports.
  async function tokenLamports() {
    return BigInt((await issuingKey()).denomination);
  }

  async function accountBalance(identity) {
    const a = await coord.pay.account(identity.id);
    return a ? BigInt(a.balance) : 0n;
  }

  return {
    wallet,
    fund,
    topUp,
    tokenLamports,
    has: (nodeId) => byNode.has(nodeId),
    // The account each node is paid from now.
    accounts: () => [...byNode.entries()].map(([node, id]) => ({ node, account: id.id })),
    // Every account ever made, oldest first; current marks the one in use for its node.
    allAccounts: () => all.map((r) => ({ node: r.node, account: r.identity.id, current: byNode.get(r.node) === r.identity })),
    // Every identity of a node, newest first (a computer rented earlier was paid by an older one).
    identitiesFor: (nodeId) => all.filter((r) => r.node === nodeId).map((r) => r.identity).reverse(),
    isCurrent: (nodeId, accountId) => { const id = byNode.get(nodeId); return !id || id.id === accountId; },
    // A node refused a payment (src/relay calls this). Handed to the automatic top up, if one listens.
    short(nodeId, reason) { if (shortHandler) shortHandler(nodeId, reason); },
    onShort(fn) { shortHandler = typeof fn === 'function' ? fn : null; },
    // Synchronous, as src/relay needs it. Unknown node: starts funding and returns null this time.
    identityFor(nodeId) {
      const id = byNode.get(nodeId);
      if (id) return id;
      if (!funding.has(nodeId)) {
        const p = fund([nodeId]).catch((err) => log('warn', 'credit.fund_failed', { node: nodeId, reason: String(err && err.message).slice(0, 120) })).finally(() => funding.delete(nodeId));
        funding.set(nodeId, p);
      }
      return null;
    },
    async balanceOf(nodeId) {
      const id = byNode.get(nodeId);
      return id ? accountBalance(id) : 0n;
    },
    // Total credit left over every throwaway account.
    async balance() {
      let total = 0n;
      for (const r of all) total += await accountBalance(r.identity);
      return { lamports: total.toString() };
    },
    async balanceOfAccount(identity) { return accountBalance(identity); },
    async walletBalance() {
      return coord.pay.balance(balanceRequest(wallet));
    },
  };
}

// The payer shape src/compute's MCP server and autopay want: one node at a time, so
// balance() is that node's account (a voucher above it would only be partly covered).
export function payerFor(credit, nodeId = null) {
  let current = nodeId;
  return {
    identityFor(id) { current = id; return credit.identityFor(id); },
    async balance() { return { lamports: (current ? await credit.balanceOf(current) : 0n).toString() }; },
  };
}

// Automatic top up for long running client tools (proxy, rent, MCP).
//
// When a node's current account runs low it buys `tokens` more (fresh account by default, see
// topUp). It never spends more than `limitLamports` in any 24 hours, counted over every run that
// uses the same data folder (the record is <dir>/credit/auto-top-up.json), so a tool left running
// or restarted cannot empty the wallet by itself. limitLamports 0 turns it off.
//
// It looks at an account when check() runs (callers run it on a timer) and right away when a node
// refuses a payment (credit.short). A refusal alone never buys anything: the account's balance is
// read first, so a node that lies about being unpaid cannot make it spend.
export const AUTO_TOP_UP_DEFAULT_LIMIT = 10_000_000n; // 0.01 SOL per 24 hours
const DAY_MS = 24 * 3600_000;

export async function createAutoTopUp({ credit, dir, limitLamports = AUTO_TOP_UP_DEFAULT_LIMIT, tokens = 1, fresh = true, lowLamports = null, log = () => {}, now = Date.now } = {}) {
  if (!credit || !dir) throw new Error('auto top up: credit and dir are required');
  const limit = BigInt(limitLamports);
  if (limit < 0n) throw new Error('auto top up: the limit cannot be negative');
  if (!Number.isInteger(tokens) || tokens < 1) throw new Error('auto top up: tokens must be a positive whole number');
  const file = path.join(dir, 'credit', 'auto-top-up.json');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });

  async function readSpends() {
    try {
      const j = JSON.parse(await fs.readFile(file, 'utf8'));
      return (Array.isArray(j.spends) ? j.spends : []).filter((x) => x && Number.isFinite(x.at) && /^[0-9]+$/.test(String(x.lamports)));
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      // an unreadable record must not reset the limit: treat the whole limit as used
      return [{ at: now(), lamports: limit.toString() }];
    }
  }
  async function writeSpends(spends) {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ spends }, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tmp, file);
  }
  async function spentToday() {
    const since = now() - DAY_MS;
    const spends = (await readSpends()).filter((x) => x.at > since);
    return { spends, total: spends.reduce((a, x) => a + BigInt(x.lamports), 0n) };
  }

  let chain = Promise.resolve();
  const inFlight = new Set();
  let limitLogged = 0;
  const summary = { toppedUp: 0, spentLamports: 0n, skippedLimit: 0 };

  async function checkOne(nodeId, token, fresh) {
    if (!credit.has(nodeId)) return null;
    const low = lowLamports !== null ? BigInt(lowLamports) : token / 4n;
    const bal = await credit.balanceOf(nodeId);
    if (bal >= low && bal > 0n) return null;
    const cost = token * BigInt(tokens);
    const { spends, total } = await spentToday();
    if (total + cost > limit) {
      summary.skippedLimit += 1;
      if (now() - limitLogged > 60_000) {
        limitLogged = now();
        log('warn', 'credit.top_up_limit_reached', { node: nodeId, limitLamports: limit.toString(), spentLamports: total.toString(), note: 'automatic top up waits until the last 24 hours spent less; raise --top-up-limit or run credit --top-up' });
      }
      return { node: nodeId, toppedUp: false, reason: 'limit' };
    }
    // recorded before buying, so a crash halfway can only make the limit stricter, never looser
    await writeSpends([...spends, { at: now(), lamports: cost.toString() }]);
    const [r] = await credit.topUp(nodeId, tokens, { fresh });
    summary.toppedUp += 1;
    summary.spentLamports += cost;
    log('info', 'credit.topped_up', { node: nodeId, account: r.account, fresh: r.fresh, lamports: cost.toString(), balanceBefore: bal.toString() });
    return { node: nodeId, toppedUp: true, ...r, lamports: cost.toString() };
  }

  // Look at these nodes' accounts and top up the low ones. Runs one at a time.
  // opts.fresh overrides the default for this call (a running computer is topped up in place).
  function check(nodeIds, { fresh: useFresh = fresh } = {}) {
    const run = chain.then(async () => {
      if (limit === 0n) return [];
      const token = await credit.tokenLamports();
      const out = [];
      for (const id of [...new Set(nodeIds)]) {
        try { const r = await checkOne(id, token, useFresh); if (r) out.push(r); } catch (err) {
          log('warn', 'credit.top_up_failed', { node: id, reason: String(err && err.message).slice(0, 160) });
          out.push({ node: id, toppedUp: false, reason: 'failed' });
        }
      }
      return out;
    });
    chain = run.catch(() => {});
    return run;
  }

  function poke(nodeId) {
    if (limit === 0n || inFlight.has(nodeId)) return null;
    inFlight.add(nodeId);
    return check([nodeId]).finally(() => inFlight.delete(nodeId));
  }

  credit.onShort((nodeId) => { poke(nodeId); });

  return {
    check,
    poke,
    idle: () => chain,
    enabled: limit > 0n,
    limitLamports: limit.toString(),
    fresh,
    stats: () => ({ toppedUp: summary.toppedUp, spentLamports: summary.spentLamports.toString(), skippedLimit: summary.skippedLimit }),
    spentToday: async () => (await spentToday()).total.toString(),
    stop() { credit.onShort(null); },
  };
}
