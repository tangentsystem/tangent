// Client credit: top up (fresh account or in place), the automatic top up and its 24 hour limit,
// and the withdraw helpers, against the real pay module (sim Rings) over real HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIdentity, signVoucher, unb58 } from '../core/index.js';
import { makePay, fund } from '../pay/testkit.js';
import { createKeystore } from './keystore.js';
import { createCoordinatorClient } from './coord-client.js';
import { createCredit, createAutoTopUp } from './credit.js';
import { checkWithdrawArgs, requestWithdrawal, followWithdrawal } from './withdraw.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENT_BIN = path.join(ROOT, 'bin', 'client.js');
const TOKEN = 1_000_000n; // the smallest denomination

async function harness() {
  const ctx = makePay({ now: Date.now });
  const app = express();
  app.use('/api/pay', ctx.pay.router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tangent-credit-'));
  const coord = createCoordinatorClient({ url, coordinatorId: createIdentity().id });
  const open = async () => createCredit({ coord, keystore: await createKeystore({ dir }), dir });
  const node = createIdentity();
  ctx.nodes.add(node.id);
  return {
    ctx, url, dir, coord, open, node,
    async close() { await new Promise((r) => { server.close(r); server.closeAllConnections(); }); await fs.rm(dir, { recursive: true, force: true }); },
  };
}

// Spend everything left on an account, as a node would by redeeming a voucher.
let sessionNo = 0;
async function drain(h, identity) {
  const a = await h.ctx.pay.account(identity.id);
  const v = signVoucher(identity, { session: `drain-${++sessionNo}`, node: h.node.id, kind: 'relay', cumulative: BigInt(a.balance), seq: 1, expires: Date.now() + 60_000 });
  const r = await h.ctx.pay.redeemVoucher(v, { node: h.node.id });
  assert.equal(r.ok, true, JSON.stringify(r));
}

async function keyFiles(dir) { return (await fs.readdir(path.join(dir, 'keys'))).filter((n) => n.startsWith('acct-')).sort(); }

test('top up: fresh account by default, in place on request, the old key is kept and reloads in order', async () => {
  const h = await harness();
  try {
    const c = await h.open();
    await fund(h.ctx, c.wallet, 20_000_000n);
    await c.fund([h.node.id]);
    const first = c.identitiesFor(h.node.id)[0];
    assert.equal(await c.balanceOf(h.node.id), TOKEN);
    await drain(h, first);
    assert.equal(await c.balanceOf(h.node.id), 0n);

    // fund() leaves a node that has an account alone
    assert.deepEqual(await c.fund([h.node.id]), []);

    // fresh (default): a new account holds the new tokens and becomes current
    const [r1] = await c.topUp(h.node.id, 2);
    assert.equal(r1.fresh, true);
    assert.equal(r1.previous, first.id);
    assert.notEqual(r1.account, first.id);
    assert.equal(await c.balanceOf(h.node.id), 2n * TOKEN);
    assert.equal(c.isCurrent(h.node.id, first.id), false);
    assert.equal(c.isCurrent(h.node.id, r1.account), true);
    assert.deepEqual(c.allAccounts().map((a) => a.current), [false, true]);
    const before = await keyFiles(h.dir);
    assert.equal(before.length, 2, 'both keys are on disk');
    const firstFile = await fs.readFile(path.join(h.dir, 'keys', before[0]), 'utf8');

    // in place: same account, more credit
    const [r2] = await c.topUp(h.node.id, 1, { fresh: false });
    assert.deepEqual([r2.fresh, r2.account], [false, r1.account]);
    assert.equal(await c.balanceOf(h.node.id), 3n * TOKEN);
    assert.deepEqual(await keyFiles(h.dir), before, 'no key made, none removed');
    assert.equal(await fs.readFile(path.join(h.dir, 'keys', before[0]), 'utf8'), firstFile, 'saved keys are never rewritten');
    assert.equal((await c.balance()).lamports, (3n * TOKEN).toString(), 'total counts every account');

    // a new run picks the newest account as current and still knows the old one
    const again = await h.open();
    assert.equal(again.accounts()[0].account, r1.account);
    assert.deepEqual(again.identitiesFor(h.node.id).map((x) => x.id), [r1.account, first.id]);
  } finally { await h.close(); }
});

test('automatic top up: low account gets more, a refusal alone buys nothing, the 24 hour limit holds across runs', async () => {
  const h = await harness();
  try {
    const c = await h.open();
    await fund(h.ctx, c.wallet, 50_000_000n);
    await c.fund([h.node.id]);
    const logs = [];
    let t = Date.now();
    const now = () => t;
    const auto = await createAutoTopUp({ credit: c, dir: h.dir, limitLamports: 2n * TOKEN, log: (...a) => logs.push(a), now });

    // full account: nothing to do, even when a node claims it was not paid
    assert.deepEqual(await auto.check([h.node.id]), []);
    c.short(h.node.id, 'insufficient funds');
    await auto.idle();
    assert.equal(auto.stats().toppedUp, 0, 'a refusal is checked against the real balance first');

    // used up: the refusal triggers a fresh account with one token
    const old = c.identitiesFor(h.node.id)[0];
    await drain(h, old);
    c.short(h.node.id, 'insufficient funds');
    await auto.idle();
    await auto.idle();
    assert.equal(auto.stats().toppedUp, 1);
    assert.notEqual(c.accounts()[0].account, old.id, 'fresh account by default');
    assert.equal(await c.balanceOf(h.node.id), TOKEN);

    // in place when asked (a running computer)
    const cur = c.identitiesFor(h.node.id)[0];
    await drain(h, cur);
    const [r] = await auto.check([h.node.id], { fresh: false });
    assert.deepEqual([r.toppedUp, r.fresh, r.account], [true, false, cur.id]);
    assert.equal(await auto.spentToday(), (2n * TOKEN).toString());

    // the limit (2 tokens in 24 hours) is reached: no more, and a new run sees the same record
    await drain(h, cur);
    const [r3] = await auto.check([h.node.id]);
    assert.deepEqual([r3.toppedUp, r3.reason], [false, 'limit']);
    assert.ok(logs.some(([, e]) => e === 'credit.top_up_limit_reached'));
    const c2 = await h.open();
    const auto2 = await createAutoTopUp({ credit: c2, dir: h.dir, limitLamports: 2n * TOKEN, now });
    assert.equal((await auto2.check([h.node.id]))[0].reason, 'limit', 'a restart does not reset the limit');

    // a day later the window has room again
    t += 24 * 3600_000 + 1000;
    const [r4] = await auto2.check([h.node.id]);
    assert.equal(r4.toppedUp, true);

    // limit 0 turns it off
    const off = await createAutoTopUp({ credit: c2, dir: h.dir, limitLamports: 0n, now });
    await drain(h, c2.identitiesFor(h.node.id)[0]);
    assert.deepEqual(await off.check([h.node.id]), []);
    assert.equal(off.poke(h.node.id), null);
    const bal = await c2.walletBalance();
    assert.equal(BigInt(bal.balance), 50_000_000n - 4n * TOKEN, 'wallet paid for 1 + 3 tokens, nothing else');
  } finally { await h.close(); }
});

test('an unreadable top up record counts as the whole limit used', async () => {
  const h = await harness();
  try {
    const c = await h.open();
    await fund(h.ctx, c.wallet, 10_000_000n);
    await c.fund([h.node.id]);
    await drain(h, c.identitiesFor(h.node.id)[0]);
    await fs.writeFile(path.join(h.dir, 'credit', 'auto-top-up.json'), '{ not json');
    const auto = await createAutoTopUp({ credit: c, dir: h.dir, limitLamports: 5n * TOKEN });
    assert.equal((await auto.check([h.node.id]))[0].reason, 'limit');
  } finally { await h.close(); }
});

test('withdraw arguments are checked before anything is signed', () => {
  const to = createIdentity().id;
  assert.deepEqual(checkWithdrawArgs({ to, lamports: '2000000' }), { to, amount: '2000000', public: false });
  assert.deepEqual(checkWithdrawArgs({ to, lamports: '2000000', public: true }), { to, amount: '2000000', public: true });
  assert.deepEqual(checkWithdrawArgs({ id: 'abcdefgh1234' }), { follow: 'abcdefgh1234' });
  for (const [v, msg] of [
    [{ lamports: '1' }, /--to is required/],
    [{ to: 'nope', lamports: '1' }, /Solana address/],
    [{ to }, /--lamports is required/],
    [{ to, lamports: '0' }, /above 0/],
    [{ to, lamports: '1.5' }, /whole number/],
    [{ to, lamports: '-3' }, /whole number/],
    [{ id: 'x' }, /withdrawal id/],
    [{ id: 'abcdefgh1234', to }, /leave out/],
  ]) assert.throws(() => checkWithdrawArgs(v), (e) => e.usage === true && msg.test(e.message), JSON.stringify(v));
});

test('withdraw: signed by the wallet, followed until sent; a refusal to send refunds and is reported', async () => {
  const h = await harness();
  try {
    const c = await h.open();
    await fund(h.ctx, c.wallet, 10_000_000n);
    const to = createIdentity().id;
    const acc = await requestWithdrawal({ coord: h.coord, wallet: c.wallet, to, amount: '3000000', public: true });
    assert.equal(acc.status, 'pending');
    assert.equal(acc.balance, '7000000');
    const seen = [];
    let n = 0;
    const r = await followWithdrawal({
      coord: h.coord, id: acc.id, everyMs: 1, onUpdate: (w) => seen.push(w.status),
      sleep: async () => { if (++n === 2) await h.ctx.pay.processWithdrawals(); },
    });
    assert.equal(r.done, true);
    assert.equal(r.withdrawal.status, 'sent');
    assert.match(r.withdrawal.explorer, /^https:\/\/solscan\.io\/tx\//);
    assert.deepEqual(seen, ['pending', 'sent']);
    assert.equal(h.ctx.rings.sim.publicBalanceOf(to), 3_000_000n);

    // a private send to an address with no Privacy Rings wallet cannot be sent: refunded
    const bad = createIdentity().id;
    h.ctx.rings.sim.setRegistered(bad, false);
    const acc2 = await requestWithdrawal({ coord: h.coord, wallet: c.wallet, to: bad, amount: '2000000' });
    await h.ctx.pay.processWithdrawals();
    const r2 = await followWithdrawal({ coord: h.coord, id: acc2.id, everyMs: 1 });
    assert.equal(r2.withdrawal.status, 'refunded');
    assert.equal((await c.walletBalance()).balance, '7000000', 'the amount is back');

    // still pending at the time limit: reported as not done
    const acc3 = await requestWithdrawal({ coord: h.coord, wallet: c.wallet, to, amount: '1000000' });
    const r3 = await followWithdrawal({ coord: h.coord, id: acc3.id, timeoutMs: 0, everyMs: 1 });
    assert.deepEqual([r3.done, r3.withdrawal.status], [false, 'pending']);

    // a wrong amount and a replay are refused by pay itself
    await assert.rejects(requestWithdrawal({ coord: h.coord, wallet: c.wallet, to, amount: '999999999' }), (e) => e.code === 'INSUFFICIENT_BALANCE');
    await assert.rejects(followWithdrawal({ coord: h.coord, id: 'nosuchwithdrawal', everyMs: 1 }), /no withdrawal/);
  } finally { await h.close(); }
});

// ---- the CLI itself

function cli(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLIENT_BIN, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('cli timed out: ' + err)); }, timeoutMs);
    p.on('exit', (code) => {
      clearTimeout(t);
      let json = null;
      try { json = JSON.parse(out.trim().split('\n').pop()); } catch { /* none */ }
      resolve({ code, json, err });
    });
  });
}

test('CLI: credit --top-up (fresh and --same-account), withdraw end to end, usage errors exit 2', async () => {
  const h = await harness();
  const tick = setInterval(() => { h.ctx.pay.processWithdrawals().catch(() => {}); }, 200);
  try {
    const base = ['--coordinator', h.url, '--coordinator-id', createIdentity().id, '--data', h.dir];
    const w = await cli(['wallet', ...base]);
    assert.equal(w.code, 0, w.err);
    const wallet = { id: w.json.wallet };
    await fund(h.ctx, wallet, 30_000_000n);

    const f = await cli(['credit', ...base, '--nodes', h.node.id]);
    assert.equal(f.code, 0, f.err);
    assert.equal(f.json.funded.length, 1);
    const first = f.json.funded[0].account;

    // without --top-up a node with an account gets nothing
    const n0 = await cli(['credit', ...base, '--nodes', h.node.id, '--tokens', '2']);
    assert.deepEqual([n0.json.funded, n0.json.toppedUp], [[], []]);

    const keyOf = async (id) => {
      const ks = await createKeystore({ dir: h.dir });
      const row = (await ks.list('acct-')).find((r) => r.publicKey === id);
      return createIdentity(unb58(row.secret));
    };
    await drain(h, await keyOf(first));

    const t1 = await cli(['credit', ...base, '--nodes', h.node.id, '--top-up', '--tokens', '2']);
    assert.equal(t1.code, 0, t1.err);
    assert.equal(t1.json.toppedUp[0].fresh, true);
    assert.notEqual(t1.json.toppedUp[0].account, first);
    const t2 = await cli(['credit', ...base, '--nodes', h.node.id, '--top-up', '--same-account']);
    assert.deepEqual([t2.json.toppedUp[0].fresh, t2.json.toppedUp[0].account], [false, t1.json.toppedUp[0].account]);

    const b = await cli(['balance', ...base]);
    assert.equal(b.code, 0, b.err);
    assert.equal(b.json.accounts.length, 2);
    assert.deepEqual(b.json.accounts.map((a) => [a.current, a.balance]), [[false, '0'], [true, (3n * TOKEN).toString()]]);

    assert.equal((await cli(['credit', ...base, '--nodes', h.node.id, '--same-account'])).code, 2, '--same-account needs --top-up');

    // withdraw: usage errors
    assert.equal((await cli(['withdraw', ...base, '--lamports', '1000000'])).code, 2);
    assert.equal((await cli(['withdraw', ...base, '--to', 'bad', '--lamports', '1000000'])).code, 2);
    assert.equal((await cli(['withdraw', ...base, '--to', createIdentity().id, '--lamports', '0'])).code, 2);

    // withdraw: accepted, sent, explorer link
    const to = createIdentity().id;
    const wd = await cli(['withdraw', ...base, '--to', to, '--lamports', '4000000', '--public']);
    assert.equal(wd.code, 0, wd.err);
    assert.equal(wd.json.status, 'sent');
    assert.equal(wd.json.public, true);
    assert.match(wd.json.explorer, /^https:\/\/solscan\.io\/tx\//);
    assert.equal(h.ctx.rings.sim.publicBalanceOf(to), 4_000_000n);
    const again = await cli(['withdraw', ...base, '--id', wd.json.id]);
    assert.deepEqual([again.code, again.json.status, again.json.signature], [0, 'sent', wd.json.signature]);

    // too much: a clear message, nothing sent
    const big = await cli(['withdraw', ...base, '--to', to, '--lamports', '900000000']);
    assert.equal(big.code, 1);
    assert.match(big.err, /wallet balance too low/);

    // could not be sent: refunded, exit 1, the balance is whole again
    const bad = createIdentity().id;
    h.ctx.rings.sim.setRegistered(bad, false);
    const before = (await cli(['balance', ...base])).json.walletBalance.balance;
    const ref = await cli(['withdraw', ...base, '--to', bad, '--lamports', '1000000']);
    assert.deepEqual([ref.code, ref.json.status], [1, 'refunded']);
    assert.equal((await cli(['balance', ...base])).json.walletBalance.balance, before);
  } finally { clearInterval(tick); await h.close(); }
});
