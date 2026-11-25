// Tangent Systems additions to the adapter tests: memo binding, the deposit memo prefix in the real adapter, and the
// sim's exactly-once and fault behaviour that the pay module relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializePoseidon } from '@heliuslabs/spr';
import { createIdentity } from '../../core/identity.js';
import { createMemoryStore, kvFromStore } from '../store.js';
import { createRealRings } from './real.js';
import { createSimRings, simVaultAddress } from './sim.js';
import { createRingsAdapter, planDeposit, memoTarget, isPermanent } from './index.js';

const A = createIdentity().id;
const B = createIdentity().id;

test('memo binding: memo wallet first, sender second, junk ignored', () => {
  assert.equal(memoTarget('tangent:' + A), A);
  assert.equal(memoTarget(' tangent:' + A + ' '), A);
  assert.equal(memoTarget('tangent:nope'), null);
  assert.equal(memoTarget('l2:' + A), null);
  assert.deepEqual(planDeposit({ id: 'x:0', from: B, asset: 'SOL', amount: 5n, memo: 'tangent:' + A }), { action: 'credit', wallet: A, amount: 5n, by: 'memo' });
  assert.deepEqual(planDeposit({ id: 'x:0', from: B, asset: 'SOL', amount: 5n, memo: '' }), { action: 'credit', wallet: B, amount: 5n, by: 'sender' });
  assert.equal(planDeposit({ id: 'x:0', from: null, asset: 'SOL', amount: 5n }).reason, 'no_sender');
  assert.equal(planDeposit({ id: 'x:0', from: B, asset: 'SOL', amount: 0n }).reason, 'zero_amount');
  assert.equal(planDeposit({ id: '', from: B, asset: 'SOL', amount: 1n }).reason, 'bad_item');
});

test('real adapter: a public deposit carries the configured memo prefix and the wallet to credit', async () => {
  let seen = null;
  const deps = {
    initializePoseidon,
    createSprClient: async () => ({}),
    buildDepositTransaction: async (input) => {
      seen = input;
      return { lifetimeConstraint: { blockhash: 'h', lastValidBlockHeight: 5n }, messageBytes: new Uint8Array(0), signatures: {} };
    },
  };
  const rings = createRealRings({ ringsMode: 'real', ringsSeed: Buffer.alloc(32, 4), ringsEndpoint: 'http://127.0.0.1:8899' }, { storage: kvFromStore(createMemoryStore()), deps });
  await rings.buildPublicDeposit({ from: A, amount: 7n, creditTo: B }).catch(() => {}); // wire encoding of the fake tx may fail; the memo is what matters
  assert.equal(new TextDecoder().decode(seen.memo), 'tangent:' + B);
  assert.equal(String(seen.feePayer), A);
  assert.equal(seen.amount, 7n);
});

test('factory: sim without config, the vault label is not a key anyone holds; real needs a key and storage', async () => {
  const sim = await createRingsAdapter({});
  assert.equal(sim.mode, 'sim');
  assert.equal(sim.vaultAddress(), simVaultAddress({}));
  const seed = Buffer.alloc(32, 3);
  assert.equal(simVaultAddress({ ringsSeed: seed }), createIdentity(seed).id);
  await assert.rejects(createRingsAdapter({ ringsMode: 'real', ringsSeed: seed, ringsEndpoint: 'http://127.0.0.1:8899' }, {}), /storage/);
  const real = await createRingsAdapter({ ringsMode: 'real', ringsSeed: seed, ringsEndpoint: 'http://127.0.0.1:8899' }, { storage: kvFromStore(createMemoryStore()) });
  assert.equal(real.vaultAddress(), createIdentity(seed).id);
});

test('sim: one payment per idempotency key, faults behave as documented', async () => {
  const r = createSimRings({});
  r.sim.fund(A, 'SOL', 100n);
  r.sim.userSendToVault(A, 'SOL', 100n);
  const p1 = await r.sendPrivate({ to: B, asset: 'SOL', amount: 10n, idempotencyKey: 'k1' });
  assert.deepEqual(await r.sendPrivate({ to: B, asset: 'SOL', amount: 10n, idempotencyKey: 'k1' }), p1);
  assert.equal(r.sim.balanceOf(B, 'SOL'), 10n);
  r.sim.failNextSend();
  await assert.rejects(r.sendPrivate({ to: B, asset: 'SOL', amount: 10n, idempotencyKey: 'k2' }), (e) => !isPermanent(e));
  r.sim.crashAfterNextSend();
  await assert.rejects(r.sendPrivate({ to: B, asset: 'SOL', amount: 10n, idempotencyKey: 'k2' }), /crash/);
  await r.sendPrivate({ to: B, asset: 'SOL', amount: 10n, idempotencyKey: 'k2' });
  assert.equal(r.sim.balanceOf(B, 'SOL'), 20n);
  r.sim.setRegistered(B, false);
  await assert.rejects(r.sendPrivate({ to: B, asset: 'SOL', amount: 1n, idempotencyKey: 'k3' }), (e) => isPermanent(e) && e.code === 'RECIPIENT_NOT_REGISTERED');
  await assert.rejects(r.sendPrivate({ to: A, asset: 'SOL', amount: 1000n, idempotencyKey: 'k4' }), (e) => !isPermanent(e) && e.code === 'INSUFFICIENT_VAULT_BALANCE');
  const page = await r.listIncoming({});
  assert.equal(page.items.length, 1);
  assert.equal((await r.listIncoming({ cursor: page.cursor })).items.length, 0);
});
