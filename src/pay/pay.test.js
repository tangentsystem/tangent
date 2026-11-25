import test from 'node:test';
import assert from 'node:assert/strict';
import { signVoucher } from '../core/voucher.js';
import { makePay, fund, buyTokens, redeemInto, withdrawReq, createIdentity, newAccount, fakeNodes, clock } from './testkit.js';
import { createMemoryStore, COLLECTIONS as C } from './store.js';
import { createSimRings } from './rings/sim.js';
import { balanceRequest } from './client.js';

const rejects = (p, code) => assert.rejects(p, (e) => {
  assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
  return true;
});

// ---------------------------------------------------------------- deposits

test('deposits: credited exactly once across repeated, concurrent and restarted syncs', async () => {
  const store = createMemoryStore();
  const rings = createSimRings({});
  const ctx = makePay({ store, rings });
  const alice = createIdentity();
  const bob = createIdentity();
  rings.sim.fund(alice.id, 'SOL', 5_000_000n);
  rings.sim.userSendToVault(alice.id, 'SOL', 3_000_000n);
  rings.sim.userSendToVault(alice.id, 'SOL', 2_000_000n);
  // public deposit built for bob's wallet, landed: credited by memo
  const built = await ctx.pay.depositTx(bob.id, '7000000');
  rings.sim.submitPublicDeposit(built.tx);
  rings.sim.submitPublicDeposit(built.tx); // the same tx lands once

  const results = await Promise.all([ctx.pay.syncDeposits(), ctx.pay.syncDeposits(), ctx.pay.syncDeposits()]);
  assert.equal(results[0].credited, 3);
  assert.equal((await ctx.pay.balance(alice.id)).balance, '5000000');
  assert.equal((await ctx.pay.balance(bob.id)).balance, '7000000');

  // a second instance on the same store, with the cursor rewound (as after a crash before the cursor write)
  await store.tx(async (t) => t.put(C.meta, 'deposit_cursor', { cursor: null }));
  const other = makePay({ store, rings });
  const [r1, r2] = await Promise.all([other.pay.syncDeposits(), ctx.pay.syncDeposits()]);
  assert.equal(r1.credited + r2.credited, 0);
  assert.equal(r1.duplicate + r2.duplicate, 6);
  assert.equal((await ctx.pay.balance(alice.id)).balance, '5000000');
  assert.equal((await ctx.pay.balance(bob.id)).balance, '7000000');

  // memo naming a wallet wins over the sender; junk memo falls back to the sender
  const carol = createIdentity();
  rings.sim.fund(alice.id, 'SOL', 2n);
  rings.sim.userSendToVault(alice.id, 'SOL', 1n, 'tangent:' + carol.id);
  rings.sim.userSendToVault(alice.id, 'SOL', 1n, 'tangent:not-a-key');
  await ctx.pay.syncDeposits();
  assert.equal((await ctx.pay.balance(carol.id)).balance, '1');
  assert.equal((await ctx.pay.balance(alice.id)).balance, '5000001');
  const t = await ctx.pay.totals();
  assert.equal(t.deposits, '12000002');
  assert.equal(t.balanced, true);
});

test('deposits: items that cannot be bound to a wallet are recorded as ignored, never credited', async () => {
  const ctx = makePay();
  const sendInvalid = async (item) => {
    const orig = ctx.rings.listIncoming;
    ctx.rings.listIncoming = async () => ({ items: [item], cursor: 'x' + item.id });
    await ctx.pay.syncDeposits();
    ctx.rings.listIncoming = orig;
  };
  await sendInvalid({ id: 'a:0', from: null, asset: 'SOL', amount: 5n, memo: '' });
  await sendInvalid({ id: 'b:0', from: createIdentity().id, asset: 'USDC', amount: 5n, memo: '' });
  const rows = await ctx.store.find(C.deposits, {});
  assert.deepEqual(rows.map((r) => [r.status, r.reason]).sort(), [['ignored', 'asset_not_allowed'], ['ignored', 'no_sender']]);
  assert.equal((await ctx.pay.totals()).deposits, '0');
});

test('deposit address answers with the vault and its explorer link; balance can require a wallet signature', async () => {
  const ctx = makePay();
  const alice = createIdentity();
  const d = ctx.pay.depositAddress(alice.id);
  assert.equal(d.vault.address, ctx.rings.vaultAddress());
  assert.equal(d.vault.explorer, 'https://solscan.io/account/' + ctx.rings.vaultAddress());
  assert.equal(d.memo, 'tangent:' + alice.id);
  assert.throws(() => ctx.pay.depositAddress('nope'), (e) => e.code === 'BAD_WALLET');
  const req = balanceRequest(alice, ctx.now());
  assert.equal((await ctx.pay.balance(alice.id, req)).balance, '0');
  await rejects(ctx.pay.balance(alice.id, { ...req, ts: req.ts + 1 }), 'BAD_SIGNATURE');
  await rejects(ctx.pay.balance(alice.id, balanceRequest(alice, ctx.now() - 10 * 60000)), 'STALE_REQUEST');
});

// ---------------------------------------------------------------- vouchers

async function fundedAccount(ctx, lamports) {
  const wallet = createIdentity();
  await fund(ctx, wallet, lamports);
  const { tokens } = await buyTokens(ctx.pay, wallet, '1000000', Number(lamports / 1_000_000n));
  const account = newAccount();
  for (const t of tokens) await redeemInto(ctx.pay, t, account);
  return account;
}

const voucher = (payer, node, cumulative, seq, extra = {}) => signVoucher(payer, { session: 's1', node: node.id, kind: 'relay', cumulative: BigInt(cumulative), seq, expires: Date.now() + 3600_000, ...extra });

test('vouchers: only the increase moves, out of order vouchers credit nothing, fee taken at redemption', async () => {
  const ctx = makePay({ config: { networkFeeBps: 250 } });
  const node = createIdentity();
  ctx.nodes.add(node.id);
  const payer = await fundedAccount(ctx, 5_000_000n);

  let r = await ctx.pay.redeemVoucher(voucher(payer, node, 1_000_000, 1));
  assert.deepEqual([r.ok, r.credited, r.nodeCredited, r.fee], [true, '1000000', '975000', '25000']);
  r = await ctx.pay.redeemVoucher(voucher(payer, node, 1_000_000, 1)); // replay
  assert.deepEqual([r.ok, r.credited], [true, '0']);
  const v3 = voucher(payer, node, 2_500_000, 3);
  const v2 = voucher(payer, node, 1_800_000, 2);
  r = await ctx.pay.redeemVoucher(v3);
  assert.equal(r.credited, '1500000');
  r = await ctx.pay.redeemVoucher(v2); // older, smaller: nothing
  assert.deepEqual([r.ok, r.credited, r.reason], [true, '0', 'nothing new']);
  assert.equal((await ctx.pay.account(payer.id)).balance, '2500000');
  assert.deepEqual(await ctx.pay.earnings(node.id), { nodeId: node.id, unpaid: '2437500', earned: '2437500', paid: '0', pending: '0' });
  assert.equal((await ctx.pay.totals()).fees, '62500');
  assert.equal((await ctx.pay.totals()).balanced, true);

  // a second session of the same payer and node is tracked on its own
  r = await ctx.pay.redeemVoucher(voucher(payer, node, 100, 1, { session: 's2' }));
  assert.equal(r.credited, '100');
});

test('vouchers: refused when tampered, expired, for an unknown node, without an account, or for the wrong node', async () => {
  const now = clock();
  const ctx = makePay({ now });
  const node = createIdentity();
  const stranger = createIdentity();
  ctx.nodes.add(node.id);
  const payer = await fundedAccount(ctx, 1_000_000n);
  const good = voucher(payer, node, 10, 1, { expires: now() + 60000 });
  assert.equal((await ctx.pay.redeemVoucher({ ...good, cumulative: '999999' })).reason, 'signature');
  assert.equal((await ctx.pay.redeemVoucher(voucher(payer, node, 10, 1, { expires: now() - 1 }))).reason, 'expired');
  assert.equal((await ctx.pay.redeemVoucher(voucher(payer, stranger, 10, 1, { expires: now() + 60000 }))).reason, 'unknown node');
  assert.equal((await ctx.pay.redeemVoucher(good, { node: stranger.id })).reason, 'wrong node');
  const nobody = newAccount();
  const r = await ctx.pay.redeemVoucher(voucher(nobody, node, 10, 1, { expires: now() + 60000 }));
  assert.deepEqual([r.ok, r.reason, r.shortfall], [false, 'no account', '10']);
  assert.equal((await ctx.pay.redeemVoucher(good)).credited, '10');
  // a different kind on the same session is refused
  assert.equal((await ctx.pay.redeemVoucher(voucher(payer, node, 20, 2, { kind: 'compute', expires: now() + 60000 }))).reason, 'kind mismatch');
});

test('vouchers: account short of funds gives partial credit, the rest is collected after a top up', async () => {
  const ctx = makePay();
  const node = createIdentity();
  ctx.nodes.add(node.id);
  const payer = await fundedAccount(ctx, 2_000_000n);
  let r = await ctx.pay.redeemVoucher(voucher(payer, node, 3_000_000, 1));
  assert.deepEqual([r.ok, r.credited, r.shortfall, r.partial, r.reason], [true, '2000000', '1000000', true, 'insufficient funds']);
  assert.equal((await ctx.pay.account(payer.id)).balance, '0');
  r = await ctx.pay.redeemVoucher(voucher(payer, node, 3_000_000, 1));
  assert.deepEqual([r.ok, r.credited, r.reason], [false, '0', 'insufficient funds']);
  // top up the same account with another token, then the signed amount can be collected
  const w = createIdentity();
  await fund(ctx, w, 1_000_000n);
  const { tokens } = await buyTokens(ctx.pay, w, '1000000', 1);
  await redeemInto(ctx.pay, tokens[0], payer);
  r = await ctx.pay.redeemVoucher(voucher(payer, node, 3_000_000, 1));
  assert.deepEqual([r.ok, r.credited, r.shortfall], [true, '1000000', '0']);
  assert.equal((await ctx.pay.earnings(node.id)).unpaid, '3000000');
  assert.equal((await ctx.pay.totals()).balanced, true);
});

test('vouchers: concurrent redemption of the same and older vouchers never moves more than the newest amount', async () => {
  const ctx = makePay();
  const nodeA = createIdentity();
  const nodeB = createIdentity();
  ctx.nodes.add(nodeA.id);
  ctx.nodes.add(nodeB.id);
  const payer = await fundedAccount(ctx, 4_000_000n);
  const vs = [];
  for (let i = 1; i <= 10; i += 1) vs.push(voucher(payer, nodeA, i * 150_000, i));
  const newest = vs[vs.length - 1];
  // every voucher several times, all at once, plus a second node draining the same account
  const jobs = [...vs, ...vs, newest, newest, newest].map((v) => ctx.pay.redeemVoucher(v));
  const bJobs = [1, 2, 3].map((i) => ctx.pay.redeemVoucher(signVoucher(payer, { session: 'b', node: nodeB.id, kind: 'compute', cumulative: BigInt(i) * 1_000_000n, seq: i, expires: Date.now() + 60000 })));
  const all = await Promise.all([...jobs, ...bJobs]);
  const toA = all.slice(0, jobs.length).reduce((a, r) => a + BigInt(r.credited), 0n);
  const toB = all.slice(jobs.length).reduce((a, r) => a + BigInt(r.credited), 0n);
  assert.equal(toA, 1_500_000n);
  assert.equal(toB, 2_500_000n > 4_000_000n - toA ? 4_000_000n - toA : 2_500_000n);
  assert.equal(toA + toB + BigInt((await ctx.pay.account(payer.id)).balance), 4_000_000n);
  assert.equal(BigInt((await ctx.pay.earnings(nodeA.id)).unpaid), toA);
  assert.equal(BigInt((await ctx.pay.earnings(nodeB.id)).unpaid), toB);
  assert.equal((await ctx.pay.totals()).balanced, true);
});

// ---------------------------------------------------------------- tips

test('off grid tips: split to gateway and carriers once per transaction', async () => {
  const ctx = makePay({ config: { networkFeeBps: 100 } });
  const gw = createIdentity();
  const c1 = createIdentity();
  const c2 = createIdentity();
  const unknown = createIdentity();
  for (const n of [gw, c1, c2]) ctx.nodes.add(n.id);
  const id = '5'.repeat(88);
  const r = await ctx.pay.creditTip({ id, lamports: '100001', gateway: gw.id, carriers: [c1.id, c2.id, c2.id, gw.id, unknown.id] });
  assert.equal(r.fee, '1000');
  const shares = Object.fromEntries(r.shares.map((s) => [s.nodeId, s.lamports]));
  assert.equal(shares[c1.id], '24750');
  assert.equal(shares[c2.id], '24750');
  assert.equal(shares[gw.id], '49501');
  assert.equal(BigInt(shares[gw.id]) + 2n * 24750n + 1000n, 100001n);
  const again = await ctx.pay.creditTip({ id, lamports: '100001', gateway: gw.id, carriers: [c1.id] });
  assert.equal(again.duplicate, true);
  assert.equal((await ctx.pay.earnings(c1.id)).unpaid, '24750');
  await rejects(ctx.pay.creditTip({ id: '6'.repeat(88), lamports: '5', gateway: unknown.id }), 'UNKNOWN_NODE');
  const solo = await ctx.pay.creditTip({ id: '7'.repeat(88), lamports: '1000', gateway: gw.id });
  assert.equal(solo.shares.length, 1);
  assert.equal((await ctx.pay.totals()).balanced, true);
});

// ---------------------------------------------------------------- withdrawals

test('withdraw: private and public, signed with a one time challenge, sent once', async () => {
  const ctx = makePay();
  const alice = createIdentity();
  await fund(ctx, alice, 10_000_000n);
  const dest = createIdentity().id;
  const w1 = await withdrawReq(ctx.pay, alice, { to: dest, amount: '4000000' });
  assert.equal(w1.balance, '6000000');
  assert.equal(w1.to.explorer, 'https://solscan.io/account/' + dest);
  const w2 = await withdrawReq(ctx.pay, alice, { to: dest, amount: '1000000', public: true });
  await rejects(withdrawReq(ctx.pay, alice, { to: dest, amount: '9000000' }), 'INSUFFICIENT_BALANCE');
  let s = await ctx.pay.processWithdrawals();
  assert.deepEqual([s.sent, s.refunded], [2, 0]);
  s = await ctx.pay.processWithdrawals();
  assert.equal(s.sent, 0);
  assert.equal(ctx.rings.sim.balanceOf(dest, 'SOL'), 4_000_000n);
  assert.equal(ctx.rings.sim.publicBalanceOf(dest), 1_000_000n);
  assert.equal((await ctx.pay.withdrawal(w1.id)).status, 'sent');
  assert.match((await ctx.pay.withdrawal(w2.id)).explorer, /^https:\/\/solscan\.io\/tx\//);
  assert.equal((await ctx.pay.balance(alice.id)).balance, '5000000');
  const t = await ctx.pay.totals();
  assert.equal(t.withdrawalsSent, '5000000');
  assert.equal(t.balanced, true);
});

test('withdraw: replayed request refused; permanent failure refunds; crash after send pays once', async () => {
  const ctx = makePay();
  const alice = createIdentity();
  await fund(ctx, alice, 10_000_000n);
  const { challenge } = await ctx.pay.challenge(alice.id);
  const { withdrawRequest } = await import('./client.js');
  const dest = createIdentity().id;
  const req = withdrawRequest(alice, { challenge, to: dest, amount: '1000000' });
  await ctx.pay.withdraw(req);
  await rejects(ctx.pay.withdraw(req), 'CHALLENGE_USED');
  await rejects(ctx.pay.withdraw({ ...req, amount: '2000000' }), 'BAD_SIGNATURE');

  // recipient without a Rings private wallet: permanent, refunded
  const unregistered = createIdentity().id;
  ctx.rings.sim.setRegistered(unregistered, false);
  await withdrawReq(ctx.pay, alice, { to: unregistered, amount: '2000000' });
  // a crash right after the transfer landed
  ctx.rings.sim.crashAfterNextSend();
  let s = await ctx.pay.processWithdrawals();
  assert.deepEqual([s.sent, s.refunded, s.retry], [0, 1, 1]);
  s = await ctx.pay.processWithdrawals();
  assert.deepEqual([s.sent, s.refunded], [1, 0]);
  assert.equal(ctx.rings.sim.balanceOf(dest, 'SOL'), 1_000_000n);
  assert.equal(ctx.rings.sim.outgoing().filter((o) => o.to === dest).length, 1);
  assert.equal((await ctx.pay.balance(alice.id)).balance, '9000000');
  assert.equal((await ctx.pay.totals()).balanced, true);
});

// ---------------------------------------------------------------- payouts

async function earn(ctx, node, lamports) {
  const payer = await fundedAccount(ctx, lamports);
  const r = await ctx.pay.redeemVoucher(signVoucher(payer, { session: 'e' + Math.random(), node: node.id, kind: 'relay', cumulative: lamports, seq: 1, expires: Date.now() + 60000 }));
  assert.equal(r.credited, lamports.toString());
}

test('payouts: minimum, per run caps, sent through Rings to the payout address, idempotent', async () => {
  const ctx = makePay({ config: { payoutMinLamports: '2000000', payoutMaxPerRun: 2, payoutMaxLamportsPerRun: '9000000' } });
  const nodes = [createIdentity(), createIdentity(), createIdentity(), createIdentity()];
  const payoutAddrs = nodes.map(() => createIdentity().id);
  nodes.forEach((n, i) => ctx.nodes.add(n.id, payoutAddrs[i]));
  await earn(ctx, nodes[0], 5_000_000n);
  await earn(ctx, nodes[1], 6_000_000n);
  await earn(ctx, nodes[2], 3_000_000n);
  await earn(ctx, nodes[3], 1_000_000n); // under the minimum

  let s = await ctx.pay.runPayouts();
  assert.deepEqual([s.created, s.sent], [2, 2]); // count cap 2: the two biggest
  assert.equal(ctx.rings.sim.balanceOf(payoutAddrs[1], 'SOL'), 6_000_000n);
  assert.equal(ctx.rings.sim.balanceOf(payoutAddrs[0], 'SOL'), 3_000_000n); // lamport cap 9M: 6M + 3M
  assert.equal((await ctx.pay.earnings(nodes[0].id)).unpaid, '2000000');
  s = await ctx.pay.runPayouts();
  assert.equal(s.sent, 2);
  assert.equal(ctx.rings.sim.balanceOf(payoutAddrs[0], 'SOL'), 5_000_000n);
  assert.equal(ctx.rings.sim.balanceOf(payoutAddrs[2], 'SOL'), 3_000_000n);
  s = await ctx.pay.runPayouts();
  assert.equal(s.created, 0);
  assert.equal(ctx.rings.sim.balanceOf(payoutAddrs[3], 'SOL'), 0n);
  assert.deepEqual(await ctx.pay.earnings(nodes[0].id), { nodeId: nodes[0].id, unpaid: '0', earned: '5000000', paid: '5000000', pending: '0' });
  const list = await ctx.pay.payouts({ nodeId: nodes[0].id });
  assert.equal(list.length, 2);
  assert.ok(list.every((p) => p.status === 'sent' && p.to.address === payoutAddrs[0] && p.explorer.startsWith('https://solscan.io/tx/')));
  const t = await ctx.pay.totals();
  assert.equal(t.payoutsSent, '14000000');
  assert.equal(t.balanced, true);
});

test('payouts: crash between intent and send, and crash after send, never pay twice', async () => {
  const store = createMemoryStore();
  const rings = createSimRings({});
  const nodes = fakeNodes();
  let crash = true;
  const hooks = {
    afterPayoutIntent: async () => {
      if (crash) {
        crash = false;
        throw new Error('process died after writing the intent');
      }
    },
  };
  const ctx = makePay({ store, rings, nodes, hooks });
  const node = createIdentity();
  const payoutTo = createIdentity().id;
  nodes.add(node.id, payoutTo);
  await earn(ctx, node, 5_000_000n);
  await assert.rejects(ctx.pay.runPayouts(), /process died/);
  assert.equal(rings.sim.sendCount(), 0);
  assert.equal((await ctx.pay.payouts({ status: 'pending' })).length, 1);
  assert.equal((await ctx.pay.earnings(node.id)).pending, '5000000');
  assert.equal((await ctx.pay.totals()).balanced, true);

  // restart: a new instance reconciles the intent and pays it once
  const restarted = makePay({ store, rings, nodes });
  let s = await restarted.pay.runPayouts();
  assert.deepEqual([s.reconciled, s.sent, s.created], [1, 1, 0]);
  assert.equal(rings.sim.balanceOf(payoutTo, 'SOL'), 5_000_000n);

  // crash after the transfer landed but before it was recorded
  await earn(restarted, node, 4_000_000n);
  rings.sim.crashAfterNextSend();
  s = await restarted.pay.runPayouts();
  assert.deepEqual([s.sent, s.retry], [0, 1]);
  assert.equal(rings.sim.balanceOf(payoutTo, 'SOL'), 9_000_000n); // it did land
  const again = makePay({ store, rings, nodes });
  s = await again.pay.runPayouts();
  assert.deepEqual([s.reconciled, s.sent], [1, 1]);
  assert.equal(rings.sim.balanceOf(payoutTo, 'SOL'), 9_000_000n); // not paid a second time
  assert.equal(rings.sim.sendCount(), 2);
  assert.deepEqual(await again.pay.earnings(node.id), { nodeId: node.id, unpaid: '0', earned: '9000000', paid: '9000000', pending: '0' });
  assert.equal((await again.pay.totals()).balanced, true);
});

test('payouts: permanent failure returns the amount to earnings and waits before retrying; one worker at a time', async () => {
  const now = clock();
  const ctx = makePay({ now, config: { payoutRetryMs: 60000 } });
  const node = createIdentity();
  const payoutTo = createIdentity().id;
  ctx.nodes.add(node.id, payoutTo);
  await earn(ctx, node, 3_000_000n);
  ctx.rings.sim.setRegistered(payoutTo, false);
  let s = await ctx.pay.runPayouts();
  assert.equal(s.failed, 1);
  assert.equal((await ctx.pay.earnings(node.id)).unpaid, '3000000');
  s = await ctx.pay.runPayouts();
  assert.equal(s.created, 0); // waiting
  ctx.rings.sim.setRegistered(payoutTo, true);
  now.advance(61000);
  // two workers at once: only one gets the lease
  const [a, b] = await Promise.all([ctx.pay.runPayouts(), makePay({ store: ctx.store, rings: ctx.rings, nodes: ctx.nodes, now }).pay.runPayouts()]);
  assert.equal([a, b].filter((x) => x.skipped === 'busy').length, 1);
  assert.equal(ctx.rings.sim.balanceOf(payoutTo, 'SOL'), 3_000_000n);
  assert.equal((await ctx.pay.totals()).balanced, true);
});

test('tick sends nothing until the Rings wallet is ready, and logs what needs funding', async () => {
  const ctx = makePay();
  ctx.rings.ensureReady = async () => ({ status: 'needs_funding', address: ctx.rings.vaultAddress(), haveLamports: 0, needLamports: 2487760 });
  const alice = createIdentity();
  ctx.rings.sim.fund(alice.id, 'SOL', 5n);
  ctx.rings.sim.userSendToVault(alice.id, 'SOL', 5n);
  const r = await ctx.pay.tick();
  assert.equal(r.ready.status, 'needs_funding');
  assert.equal(r.deposits, undefined);
  const logged = ctx.logs.find(([ev]) => ev === 'pay.rings.needs_funding');
  assert.equal(logged[1].explorer, 'https://solscan.io/account/' + ctx.rings.vaultAddress());
  ctx.rings.ensureReady = async () => ({ status: 'ready' });
  const r2 = await ctx.pay.tick();
  assert.equal(r2.deposits.credited, 1);
});
