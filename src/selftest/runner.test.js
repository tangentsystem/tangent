// Self test runner with fakes for the outside world: state machine, persistence per build,
// the money gate, report shape and redaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../storage/index.js';
import { createMemoryLogger } from '../coord/log.js';
import { createSelfTest } from './runner.js';
import { STATUS, formatBlock, cleanText, sol } from './report.js';

const ADDR = 'SeLfTeSt1111111111111111111111111111111111';

function fakeFunded({ need = 8_000_000n, balance = 0n } = {}) {
  const calls = { rings: 0, offgrid: 0, plan: 0, balance: 0 };
  const f = {
    calls,
    bal: balance,
    failOffgrid: 0,
    wallet: { address: ADDR, link: `https://solscan.io/account/${ADDR}` },
    async plan() { calls.plan++; return { needLamports: need, breakdown: [{ what: 'everything', lamports: need, source: 'test' }] }; },
    async balance() { calls.balance++; return f.bal; },
    groups: [
      { id: 'rings', steps: [{ id: 'rings.register', required: true }, { id: 'rings.deposit', required: true }], async run() { calls.rings++; return { 'rings.register': { status: 'PASS', detail: 'ok' }, 'rings.deposit': { status: 'PASS', detail: 'ok' } }; } },
      {
        id: 'offgrid', steps: [{ id: 'offgrid.landed', required: true }, { id: 'offgrid.tip_claim', required: true }],
        async run() {
          calls.offgrid++;
          if (f.failOffgrid > 0) { f.failOffgrid--; throw new Error('gateway timed out'); }
          return { 'offgrid.landed': { status: 'PASS' }, 'offgrid.tip_claim': { status: 'PASS' } };
        },
      },
    ],
  };
  return f;
}

const okCheck = (id, required = true) => ({ id, title: id, required, run: async () => ({ status: 'PASS', detail: 'fine' }) });

async function setup({ checks, funded, build = '0.1.0+aaaaaaa', store, timing } = {}) {
  store = store || await createMemoryStore();
  const log = createMemoryLogger({ heliusApiKey: 'SECRETKEY123', mongoUri: 'mongodb://user:pw@host/db' });
  const st = createSelfTest({ store, log, build, freeChecks: checks || [okCheck('storage.mongo'), okCheck('network.private_internet'), { id: 'compute.sealed_docker', required: false, run: async () => ({ status: 'NOT_TESTABLE', reason: 'no Docker here' }) }], funded, timing: { pollMs: 10, stage1RetryMs: 0, stage2RetryMs: 0, ...timing }, config: { heliusApiKey: 'SECRETKEY123' } });
  return { st, store, log };
}

test('a required free check that fails keeps money closed and never asks for funds', async () => {
  const funded = fakeFunded();
  const { st, log } = await setup({ checks: [okCheck('a'), { id: 'b', required: true, run: async () => { throw new Error('rpc down'); } }], funded });
  const r = await st.tick();
  assert.equal(st.state, 'stage1_failed');
  assert.equal(st.clear(), false);
  assert.equal(r.checks.find((c) => c.id === 'b').status, STATUS.FAIL);
  assert.match(r.checks.find((c) => c.id === 'b').reason, /rpc down/);
  assert.equal(funded.calls.balance, 0, 'funding is not even looked at');
  assert.equal(funded.calls.rings + funded.calls.offgrid, 0);
  assert.ok(log.lines.some((l) => l.includes('NOT CLEAR YET') && l.includes('b (FAIL)')));
});

test('waiting for funds: nothing runs, the log says what to send; once funded stage 2 runs and money opens', async () => {
  const funded = fakeFunded({ need: 8_123_456n, balance: 1_000_000n });
  const { st, log, store } = await setup({ funded });
  let r = await st.tick();
  assert.equal(st.state, 'waiting_for_funds');
  assert.equal(st.clear(), false);
  assert.equal(funded.calls.rings + funded.calls.offgrid, 0, 'nothing is sent before the wallet is funded');
  assert.equal(r.funding.sendLamports, '7123456');
  assert.equal(r.funding.address, ADDR);
  for (const id of ['rings.register', 'offgrid.landed']) assert.equal(r.checks.find((c) => c.id === id).status, STATUS.WAITING_FOR_FUNDS);
  assert.ok(log.lines.some((l) => l.startsWith(`FUND THE SELF TEST WALLET  ${ADDR}  send ${sol(7_123_456n, { roundUp: true })} SOL`)));
  assert.equal(sol(7_123_456n, { roundUp: true }), '0.0072');

  // still short: polled again, nothing sent
  await st.tick();
  assert.equal(funded.calls.rings + funded.calls.offgrid, 0);

  funded.bal = 9_000_000n;
  r = await st.tick();
  assert.equal(st.state, 'passed');
  assert.equal(st.clear(), true);
  assert.equal(r.clear, true);
  assert.equal(r.gate.open, true);
  assert.equal(funded.calls.rings, 1);
  assert.equal(funded.calls.offgrid, 1);
  assert.ok(log.lines.some((l) => l.startsWith('CLEAR TO GO LIVE') && l.includes('TOKEN_CA')));
  assert.equal((await store.collection('selftest').get('gate')).build, '0.1.0+aaaaaaa', 'the gate opening is stored with the build that passed');
  assert.equal(r.wallet.balanceLamports, '9000000', 'leftover SOL is shown');
  // NOT_TESTABLE never blocks, and is never shown as passed
  const nt = r.checks.find((c) => c.id === 'compute.sealed_docker');
  assert.equal(nt.status, STATUS.NOT_TESTABLE);
  assert.equal(nt.required, false);
  // stored for /api/selftest
  const saved = await store.collection('selftest').get('latest');
  assert.equal(saved.report.clear, true);
});

test('stage 2 runs once EVER: restarts and new builds never spend again, the gate stays open', async () => {
  const store = await createMemoryStore();
  const funded = fakeFunded({ balance: 10_000_000n });
  const a = (await setup({ funded, store })).st;
  await a.tick();
  assert.equal(a.state, 'passed');
  assert.equal(funded.calls.rings, 1);
  const gateDoc = await store.collection('selftest').get('gate');
  assert.ok(gateDoc.openedAt);

  const b = (await setup({ funded, store })).st; // same build, after a restart
  await b.start();
  assert.equal(b.clear(), true);
  assert.equal(b.state, 'passed');
  await b.stop();

  funded.bal = 0n; // the wallet is empty now: a new push must neither ask for funds nor close the gate
  const c = (await setup({ funded, store, build: '0.1.0+bbbbbbb' })).st;
  const r = await c.tick();
  assert.equal(c.state, 'passed');
  assert.equal(c.clear(), true);
  assert.equal(r.funding, null, 'no funding request on a new build');
  assert.equal(funded.calls.rings, 1, 'a new build is NOT tested again');
  assert.equal(funded.calls.offgrid, 1);
  assert.equal(r.gateOpenedBuild, '0.1.0+aaaaaaa');
  assert.equal((await store.collection('selftest').get('gate')).openedAt, gateDoc.openedAt, 'the stored opening is never rewritten');
});

test('gate open before: a later required stage 1 failure is loud but does not close it', async () => {
  const store = await createMemoryStore();
  const funded = fakeFunded({ balance: 10_000_000n });
  await (await setup({ funded, store })).st.tick();
  let down = true;
  const checks = [okCheck('storage.mongo'), { id: 'solana.rpc', required: true, run: async () => (down ? { status: 'FAIL', reason: 'rpc down' } : { status: 'PASS' }) }];
  const { st, log } = await setup({ funded, store, checks, build: '0.1.0+ccccccc', timing: { stage1RetryMs: 0 } });
  await st.start();
  assert.equal(st.state, 'stage1_failed');
  assert.equal(st.clear(), true, 'money stays open');
  const r = st.report();
  assert.deepEqual(r.attention.map((x) => x.id), ['solana.rpc']);
  assert.deepEqual(st.summary().attention, [{ id: 'solana.rpc', status: 'FAIL' }]);
  assert.ok(log.lines.some((l) => l.startsWith('ATTENTION  required check solana.rpc is FAIL') && l.includes('rpc down')));
  assert.ok(log.lines.some((l) => l.startsWith('CLEAR TO GO LIVE')));
  assert.equal(funded.calls.rings, 1, 'nothing is spent');
  down = false;
  await st.tick();
  assert.equal(st.state, 'passed');
  assert.deepEqual(st.report().attention, []);
  await st.stop();
});

test('never opened: a stage 1 failure keeps money closed even when stage 2 passed earlier', async () => {
  const store = await createMemoryStore();
  // stage 2 stored as passed but the gate never opened (for example stage 1 failed on that boot)
  await store.collection('selftest').put('stage2', { build: 'old', steps: ['rings.register', 'rings.deposit', 'offgrid.landed', 'offgrid.tip_claim'].map((id) => ({ id, status: 'PASS' })), passedAt: new Date().toISOString() });
  const funded = fakeFunded({ balance: 0n });
  const { st } = await setup({ funded, store, checks: [{ id: 'x', required: true, run: async () => ({ status: 'FAIL', reason: 'no' }) }] });
  await st.tick();
  assert.equal(st.clear(), false);
  const ok = (await setup({ funded, store })).st;
  await ok.tick();
  assert.equal(ok.clear(), true, 'opens once stage 1 passes, without spending');
  assert.equal(funded.calls.rings + funded.calls.offgrid, 0);
});

test('a failed group is re-run after the retry window, groups that passed are not', async () => {
  const funded = fakeFunded({ balance: 10_000_000n });
  funded.failOffgrid = 1;
  const { st } = await setup({ funded, timing: { stage2RetryMs: 50 } });
  let r = await st.tick();
  assert.equal(st.state, 'stage2_failed');
  assert.equal(st.clear(), false);
  assert.equal(r.checks.find((c) => c.id === 'offgrid.landed').status, STATUS.FAIL);
  assert.match(r.checks.find((c) => c.id === 'offgrid.landed').reason, /gateway timed out/);
  assert.equal(r.checks.find((c) => c.id === 'rings.deposit').status, STATUS.PASS);
  r = await st.tick(); // inside the retry window: nothing runs
  assert.equal(funded.calls.offgrid, 1);
  await new Promise((res) => setTimeout(res, 60));
  r = await st.tick();
  assert.equal(st.state, 'passed');
  assert.equal(funded.calls.offgrid, 2);
  assert.equal(funded.calls.rings, 1, 'the passed group was not paid for twice');
});

test('a group that hangs fails on its timeout; a check returning junk is a FAIL', async () => {
  const funded = fakeFunded({ balance: 10_000_000n });
  funded.groups[1].run = () => new Promise(() => {});
  funded.groups[1].timeoutMs = 30;
  const { st } = await setup({ funded, checks: [okCheck('x'), { id: 'junk', required: false, run: async () => 'nonsense' }] });
  const r = await st.tick();
  assert.equal(r.checks.find((c) => c.id === 'junk').status, STATUS.FAIL);
  assert.equal(st.state, 'stage2_failed');
  assert.match(r.checks.find((c) => c.id === 'offgrid.landed').reason, /timed out/);
});

test('report shape and no secrets in reports or logs', async () => {
  const leaky = {
    id: 'leaky', required: false,
    run: async () => ({ status: 'FAIL', reason: `fetch https://mainnet.helius-rpc.com/?api-key=SECRETKEY123 failed with key ${'5'.repeat(88)} and mongodb://user:pw@host/db` }),
  };
  const { st, log } = await setup({ checks: [okCheck('a'), leaky], funded: fakeFunded({ balance: 10_000_000n }) });
  const r = await st.tick();
  const text = JSON.stringify(r) + log.lines.join('\n');
  for (const bad of ['SECRETKEY123', '5'.repeat(88), 'user:pw']) assert.ok(!text.includes(bad), `report leaks ${bad}`);
  for (const k of ['v', 'product', 'build', 'state', 'phase', 'clear', 'checks', 'counts', 'blockers', 'gate', 'wallet', 'funding']) assert.ok(k in r, `report has ${k}`);
  for (const c of r.checks) {
    assert.ok(['PASS', 'FAIL', 'NOT_TESTABLE', 'WAITING_FOR_FUNDS', 'SKIPPED', 'PENDING'].includes(c.status));
    assert.equal(typeof c.required, 'boolean');
    assert.ok(c.stage === 1 || c.stage === 2);
    if (c.status === 'FAIL') assert.ok(c.reason, 'failures carry a reason');
  }
  assert.deepEqual(r.gate.requiredChecks.sort(), ['a', 'offgrid.landed', 'offgrid.tip_claim', 'rings.deposit', 'rings.register']);
  assert.ok(formatBlock(r).every((l) => typeof l === 'string'));
  assert.equal(cleanText('see https://x.helius-rpc.com/?api-key=abc'), 'see [rpc]');
});

test('start() schedules polling until funded, stop() ends it', async () => {
  const funded = fakeFunded({ balance: 0n });
  const { st } = await setup({ funded, timing: { pollMs: 20 } });
  await st.start();
  assert.equal(st.state, 'waiting_for_funds');
  const before = funded.calls.balance;
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(funded.calls.balance > before, 'the balance is polled');
  funded.bal = 10_000_000n;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(st.state, 'passed');
  await st.stop();
});
