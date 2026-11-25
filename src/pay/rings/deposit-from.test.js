// depositFrom on the real adapter (the off grid tip sweep's deposit), offline: the message guard against a
// REAL mainnet Rings deposit (captured from Solana mainnet, fixtures/mainnet-deposit-tx.json) and built
// messages, and the exactly once state machine with a fake network. And the sim adapter's version against a
// LiteSVM chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getTransactionDecoder,
  pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, AccountRole,
} from '@solana/kit';
import { initializePoseidon, SHIELDED_POOL_PROGRAM_ID } from '@heliuslabs/spr';
import { LiteSVM } from 'litesvm';
import { Connection, Keypair } from '@solana/web3.js';
import { createRealRings, checkDepositMessage, KV_SEND } from './real.js';
import { createSimRings } from './sim.js';
import { createIdentity } from '../../core/identity.js';
import { createMemoryStore, kvFromStore } from '../store.js';
import { planDeposit, tipSweepMemo } from './memo.js';
import { startSvmRpc } from '../../../test/e2e/support/svm-rpc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAULT_SEED = Buffer.alloc(32, 9);
const VAULT = createIdentity(VAULT_SEED).id;
const TIP_SEED = Buffer.alloc(32, 4);
const TIP = createIdentity(TIP_SEED).id;
const base = { ringsMode: 'real', ringsSeed: VAULT_SEED, ringsEndpoint: 'https://devnet.helius-rpc.com/?api-key=dummy', ringsNetwork: 'devnet' };

function message({ payer = TIP, program = String(SHIELDED_POOL_PROGRAM_ID), extraSigner = null } = {}) {
  const accounts = [{ address: address(payer), role: AccountRole.WRITABLE_SIGNER }];
  if (extraSigner) accounts.push({ address: address(extraSigner), role: AccountRole.READONLY_SIGNER });
  const m = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(address(payer), tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 150n }, tx),
    (tx) => appendTransactionMessageInstructions([{ programAddress: address(program), accounts, data: new Uint8Array([1, 2, 3]) }], tx),
  );
  return compileTransaction(m);
}

test('deposit guard: a real mainnet Rings deposit passes; other payers, signers and programs are refused', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'mainnet-deposit-tx.json'), 'utf8'));
  const t = getTransactionDecoder().decode(Buffer.from(fx.wireBase64, 'base64'));
  assert.equal(checkDepositMessage(t.messageBytes, fx.payer), true, 'the guard reads a real version 1 deposit');
  assert.throws(() => checkDepositMessage(t.messageBytes, TIP), (e) => e.code === 'DEPOSIT_REFUSED' && e.permanent);
  assert.equal(checkDepositMessage(message().messageBytes, TIP), true);
  assert.throws(() => checkDepositMessage(message({ program: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' }).messageBytes, TIP), /other than the Rings pool/);
  assert.throws(() => checkDepositMessage(message({ extraSigner: VAULT }).messageBytes, TIP), /signer other than/);
  assert.throws(() => checkDepositMessage(new Uint8Array([9, 9, 9]), TIP), /does not decode/);
});

function fakeNet() {
  const net = { statuses: new Map(), finalizedHeight: 100n, built: 0, broadcasts: [], failBroadcast: false, storage: kvFromStore(createMemoryStore({ interleave: false })), inputs: [] };
  const client = {
    commitment: 'confirmed',
    proofService: {},
    solanaRpc: {
      getSignatureStatuses: ([sig]) => ({ send: async () => ({ value: [net.statuses.get(sig) || null] }) }),
      getBlockHeight: () => ({ send: async () => net.finalizedHeight }),
    },
    confirmTransaction: async (sig) => { const st = net.statuses.get(sig); if (!st) throw new Error('confirmation timed out'); return BigInt(st.slot); },
  };
  net.deps = {
    initializePoseidon,
    createSprClient: async () => client,
    syncWallet: async () => ({}),
    buildDepositTransaction: async (input) => {
      net.built += 1;
      net.inputs.push(input);
      return { ...message({ payer: String(input.feePayer), program: net.badProgram || String(SHIELDED_POOL_PROGRAM_ID) }), n: net.built };
    },
    sign: async (_signer, unsigned) => ({ signed: unsigned, signature: 'dsig' + unsigned.n, lastValidBlockHeight: '150' }),
    broadcast: async (_c, signed) => {
      net.broadcasts.push('dsig' + signed.n);
      net.seenAtBroadcast = await net.storage.kvGet(KV_SEND, 'sweep:1');
      if (net.failBroadcast) throw new Error('socket hang up');
      net.statuses.set('dsig' + signed.n, { slot: 9000 + signed.n, err: null, confirmationStatus: 'confirmed' });
    },
  };
  net.rings = createRealRings(base, { storage: net.storage, deps: net.deps });
  return net;
}

test('depositFrom: tip account to the vault, recorded before broadcast, exactly once per key', async () => {
  const net = fakeNet();
  const r = await net.rings.depositFrom({ fromSeed: TIP_SEED, amount: 20_000_000n, memo: tipSweepMemo(), idempotencyKey: 'sweep:1' });
  assert.deepEqual(r, { signature: 'dsig1', slot: 9001 });
  assert.equal(net.seenAtBroadcast.status, 'submitted');
  assert.equal(net.seenAtBroadcast.signature, 'dsig1');
  assert.equal(net.seenAtBroadcast.from, TIP);
  const input = net.inputs[0];
  assert.equal(String(input.feePayer), TIP);
  assert.equal(String(input.depositor), TIP);
  assert.equal(input.amount, 20_000_000n);
  assert.equal(new TextDecoder().decode(input.memo), 'tangent:tipsweep');
  // the recipient is the vault's own shielded address
  assert.equal(String(input.recipient.toString ? input.recipient : ''), String(net.rings.real.keypair().shieldedAddress()));
  // same key again: the first result, nothing built or sent
  assert.deepEqual(await net.rings.depositFrom({ fromSeed: TIP_SEED, amount: 99n, idempotencyKey: 'sweep:1' }), r);
  assert.equal(net.built, 1);
  assert.deepEqual(net.broadcasts, ['dsig1']);
});

test('depositFrom: broadcast lost, landed anyway: a retry after a restart finds it and does not deposit again', async () => {
  const net = fakeNet();
  net.failBroadcast = true;
  await assert.rejects(net.rings.depositFrom({ fromSeed: TIP_SEED, amount: 5_000n, idempotencyKey: 'sweep:1' }), (e) => e.code === 'SEND_UNCONFIRMED' && !e.permanent);
  net.statuses.set('dsig1', { slot: 9001, err: null, confirmationStatus: 'finalized' });
  const restarted = createRealRings(base, { storage: net.storage, deps: net.deps });
  assert.deepEqual(await restarted.depositFrom({ fromSeed: TIP_SEED, amount: 5_000n, idempotencyKey: 'sweep:1' }), { signature: 'dsig1', slot: 9001 });
  assert.equal(net.built, 1);
});

test('depositFrom: an attempt that may still land blocks a new one; once provably dead, the SAME amount is sent again', async () => {
  const net = fakeNet();
  net.failBroadcast = true;
  await assert.rejects(net.rings.depositFrom({ fromSeed: TIP_SEED, amount: 7_000n, idempotencyKey: 'sweep:1' }));
  net.failBroadcast = false;
  net.finalizedHeight = 150n; // blockhash still valid
  await assert.rejects(net.rings.depositFrom({ fromSeed: TIP_SEED, amount: 7_000n, idempotencyKey: 'sweep:1' }), (e) => e.code === 'SEND_PENDING');
  assert.equal(net.built, 1);
  net.finalizedHeight = 999n; // dead on the finalized chain, never landed
  const r = await net.rings.depositFrom({ fromSeed: TIP_SEED, amount: 123_456n, idempotencyKey: 'sweep:1' });
  assert.equal(r.signature, 'dsig2');
  assert.equal(net.inputs[1].amount, 7_000n, 'the retry moves exactly the recorded amount');
  const rec = await net.storage.kvGet(KV_SEND, 'sweep:1');
  assert.equal(rec.attempt, 2);
  assert.deepEqual(rec.previous, ['dsig1']);
});

test('depositFrom: refuses before signing (bad program, the vault itself, bad seed)', async () => {
  const net = fakeNet();
  net.badProgram = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
  await assert.rejects(net.rings.depositFrom({ fromSeed: TIP_SEED, amount: 5n, idempotencyKey: 'sweep:1' }), (e) => e.code === 'DEPOSIT_REFUSED' && e.permanent);
  assert.equal(net.broadcasts.length, 0);
  assert.equal(await net.storage.kvGet(KV_SEND, 'sweep:1'), null, 'nothing recorded, nothing signed');
  await assert.rejects(net.rings.depositFrom({ fromSeed: VAULT_SEED, amount: 5n, idempotencyKey: 'x' }), (e) => e.code === 'DEPOSIT_REFUSED');
  await assert.rejects(net.rings.depositFrom({ fromSeed: Buffer.alloc(5), amount: 5n, idempotencyKey: 'y' }), (e) => e.code === 'BAD_KEY');
});

test('pay: a tip sweep deposit is recorded, never credited; the same memo from anyone else is an ordinary deposit', () => {
  const item = { id: 's:0', from: TIP, asset: 'SOL', amount: 5n, memo: 'tangent:tipsweep' };
  assert.deepEqual(planDeposit(item, { sweepFrom: TIP }), { action: 'ignore', reason: 'tip_sweep' });
  assert.equal(planDeposit({ ...item, from: VAULT }, { sweepFrom: TIP }).action, 'credit');
  assert.equal(planDeposit(item, {}).action, 'credit', 'without the tip account configured nothing is special');
});

test('sim depositFrom with a chain: SOL really leaves the tip account (LiteSVM), the vault books it once', async (t) => {
  const svm = new LiteSVM();
  const rpc = await startSvmRpc(svm);
  t.after(() => rpc.close());
  const connection = new Connection(rpc.url, 'confirmed');
  const tipKp = Keypair.fromSeed(TIP_SEED);
  svm.airdrop(tipKp.publicKey.toBase58(), 3_000_000n);
  const sim = createSimRings({ ringsSeed: VAULT_SEED });
  const r = await sim.depositFrom({ fromSeed: TIP_SEED, amount: 1_000_000n, memo: tipSweepMemo(), idempotencyKey: 'sweep:1', connection });
  assert.ok(r.signature);
  assert.equal(svm.getBalance(tipKp.publicKey.toBase58()), 3_000_000n - 1_000_000n - 5_000n);
  assert.equal(svm.getBalance(VAULT), 1_000_000n);
  assert.equal(await sim.vaultBalance('SOL'), 1_000_000n);
  assert.deepEqual(await sim.depositFrom({ fromSeed: TIP_SEED, amount: 1_000_000n, idempotencyKey: 'sweep:1', connection }), r);
  assert.equal(svm.getBalance(VAULT), 1_000_000n, 'not twice');
  const items = (await sim.listIncoming({})).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].from, TIP);
  assert.equal(items[0].memo, 'tangent:tipsweep');
});
