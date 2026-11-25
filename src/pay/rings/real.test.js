// Offline checks of the real adapter: it loads against the installed SDK, derives the vault address, and its
// cursor / sender / send-once logic behaves. No network: the SDK client and the network steps are replaced by fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializePoseidon } from '@heliuslabs/spr';
import { WalletError } from '@heliuslabs/spr/wallet';
import { SignedTeePolicy } from '@heliuslabs/spr/client';

// Fakes for the SDK and the RPC, plus the store backed kv.
import { createRingsAdapter } from './index.js';
import { createRealRings, selectIncoming, inferSender, classifySdkError, assetToMint, mintToAsset, clientConfigFrom, networkFromEndpoint, KV_SEND, KV_REGISTRATION_KEY, DEFAULT_REGISTER_LAMPORTS } from './real.js';
import { createIdentity } from '../../core/identity.js';
import { createMemoryStore, kvFromStore } from '../store.js';

const fakeStorage = () => kvFromStore(createMemoryStore({ interleave: false }));
const SEED = Buffer.alloc(32, 9);
const VAULT = createIdentity(SEED).id;
const BOB = createIdentity(Buffer.alloc(32, 2)).id;
const base = { ringsMode: 'real', ringsSeed: SEED, ringsEndpoint: 'https://devnet.helius-rpc.com/?api-key=dummy', ringsNetwork: 'devnet' };

test('real: loads, builds without touching the network, vault address is the Rings key pubkey', async () => {
  const rings = await createRingsAdapter(base, { storage: fakeStorage() });
  assert.equal(rings.mode, 'real');
  assert.equal(rings.vaultAddress(), VAULT);
  for (const fn of ['listIncoming', 'sendPrivate', 'vaultBalance']) assert.equal(typeof rings[fn], 'function');
  const from64 = createRealRings({ ...base, ringsSeed: Buffer.concat([SEED, Buffer.alloc(32, 1)]) }, { storage: fakeStorage() });
  assert.equal(from64.vaultAddress(), VAULT);
  assert.throws(() => createRealRings({ ...base, ringsSeed: undefined }, { storage: fakeStorage() }), /ringsSeed/);
  assert.throws(() => createRealRings(base, {}), /storage/);
  assert.throws(() => createRealRings({ ...base, ringsEndpoint: '', heliusApiKey: '' }, { storage: fakeStorage() }), /HELIUS_API_KEY/);
});

test('real: client config', () => {
  // mainnet is the default network; only an explicit devnet picks the devnet host and policy
  const main = clientConfigFrom({ heliusApiKey: 'k' });
  assert.equal(main.solanaRpcUrl, 'https://mainnet.helius-rpc.com/?api-key=k');
  assert.ok(main.proverTee);
  assert.equal(networkFromEndpoint(main.solanaRpcUrl), 'mainnet');
  assert.equal(networkFromEndpoint('https://devnet.helius-rpc.com/?api-key=k', 'mainnet'), 'devnet');
  assert.equal(networkFromEndpoint('https://rpc.example.com', 'mainnet'), 'mainnet');
  assert.equal(networkFromEndpoint('http://localhost:8899', 'mainnet'), undefined);
  assert.equal(clientConfigFrom({ ringsEndpoint: 'http://127.0.0.1:8899', ringsNetwork: 'mainnet' }).proverTee, undefined);
  const dev = clientConfigFrom({ heliusApiKey: 'k y', ringsNetwork: 'devnet' });
  // the policy object is opaque, so the network it is built for is checked through the same function the adapter uses
  assert.equal(networkFromEndpoint(dev.solanaRpcUrl, 'mainnet'), 'devnet');
  assert.ok(dev.proverTee instanceof SignedTeePolicy);
  assert.ok(main.proverTee instanceof SignedTeePolicy);
  assert.equal(dev.solanaRpcUrl, 'https://devnet.helius-rpc.com/?api-key=k%20y');
  assert.equal(dev.proofDataSource, 'prover');
  assert.ok(dev.proverTee);
  assert.equal(clientConfigFrom({ heliusApiKey: 'k', ringsNetwork: 'mainnet' }).solanaRpcUrl, 'https://mainnet.helius-rpc.com/?api-key=k');
  assert.equal(assetToMint('SOL'), '11111111111111111111111111111111');
  assert.equal(mintToAsset(assetToMint('SOL')), 'SOL');
  assert.equal(mintToAsset(assetToMint(BOB)), BOB);
  assert.throws(() => assetToMint('nope'), (e) => e.permanent && e.code === 'UNSUPPORTED_ASSET');
});

const row = (slot, sig, index, extra = {}) => ({ id: { signature: sig, slot: BigInt(slot), index: BigInt(index) }, kind: 'privateTransfer', direction: 'inbound', asset: '11111111111111111111111111111111', amount: 5n, ...extra });

test('real: incoming cursor never repeats a row and picks up late indexed rows', () => {
  const rows = [row(100, 'b', 1), row(90, 'a', 0), row(100, 'b', 0), row(95, 'x', 0, { direction: 'outbound' }), row(96, 'y', 0, { kind: 'split' })];
  const first = selectIncoming(rows, null, { rewind: 50 });
  assert.deepEqual(first.picked.map((r) => r.id.signature + ':' + r.id.index), ['a:0', 'b:0', 'b:1']);
  assert.equal(selectIncoming(rows, first.cursor, { rewind: 50 }).picked.length, 0);
  assert.equal(selectIncoming(rows, first.cursor, { rewind: 50 }).cursor, first.cursor);

  // the indexer reports an older transfer late: still delivered once
  rows.push(row(80, 'late', 3));
  const second = selectIncoming(rows, first.cursor, { rewind: 50 });
  assert.deepEqual(second.picked.map((r) => r.id.signature), ['late']);
  assert.equal(selectIncoming(rows, second.cursor, { rewind: 50 }).picked.length, 0);

  // paging with a limit does not skip
  const many = [row(1, 'p', 0), row(2, 'q', 0), row(3, 'r', 0)];
  const seen = [];
  let cursor = null;
  for (let i = 0; i < 5; i += 1) {
    const page = selectIncoming(many, cursor, { rewind: 50, limit: 2 });
    seen.push(...page.picked.map((r) => r.id.signature));
    cursor = page.cursor;
  }
  assert.deepEqual(seen, ['p', 'q', 'r']);

  // ids outside the window are dropped from the cursor
  const far = selectIncoming([...rows, row(1000, 'z', 0)], second.cursor, { rewind: 50 });
  assert.deepEqual(JSON.parse(far.cursor), { s: 1000, ids: ['z:0'] });
  assert.equal(selectIncoming([row(5, 'd', 0, { kind: 'deposit' })], null, { acceptPublicDeposits: false }).picked.length, 0);
  assert.equal(selectIncoming([row(5, 'd', 0, { kind: 'deposit' })], null, {}).picked.length, 1);
  assert.throws(() => selectIncoming([], 'garbage'), /cursor/);
});

test('real: sender inference rules', () => {
  const A = 'A', R = 'RELAYER', V = 'VAULT';
  assert.deepEqual(inferSender({ ownerTags: [A, V, A], signers: [A], vault: V }), { from: A, rule: 'tag+signer' });
  assert.deepEqual(inferSender({ ownerTags: [A, V], signers: [R, A], vault: V }), { from: A, rule: 'tag+signer' });
  assert.deepEqual(inferSender({ ownerTags: [A, V], signers: [R], vault: V }), { from: A, rule: 'tag-only' });
  assert.deepEqual(inferSender({ ownerTags: [V, V], signers: [A], vault: V }), { from: A, rule: 'feepayer' });
  assert.deepEqual(inferSender({ ownerTags: [V], signers: [V], vault: V }), { from: null, rule: 'unknown' });
  assert.deepEqual(inferSender({ ownerTags: [A, 'B', V], signers: [R], vault: V }), { from: null, rule: 'unknown' });
  assert.deepEqual(inferSender({ ownerTags: [A, 'B', V], signers: [A, 'B'], vault: V }), { from: A, rule: 'tag+feepayer' });
  assert.deepEqual(inferSender({ ownerTags: [A, 'B', V], signers: [R, A, 'B'], vault: V }), { from: null, rule: 'ambiguous' });
});

test('real: SDK errors map to permanent only when nothing can have been sent', () => {
  const wrapped = new WalletError('WALLET_BUILD_TRANSFER', { causeCode: 'WALLET_RECIPIENT_NOT_REGISTERED', causeCodes: ['WALLET_CREATE_TRANSFER', 'WALLET_RECIPIENT_NOT_REGISTERED'] });
  assert.equal(classifySdkError(wrapped).code, 'RECIPIENT_NOT_REGISTERED');
  assert.equal(classifySdkError(wrapped).permanent, true);
  assert.equal(classifySdkError(new WalletError('WALLET_BUILD_TRANSFER', { causeCode: 'WALLET_INSUFFICIENT_BALANCE' })).permanent, false);
  assert.equal(classifySdkError(new Error('socket hang up')).permanent, false);
});

// A fake Solana: just enough for the send-once state machine.
function fakeNet() {
  const net = { statuses: new Map(), finalizedHeight: 100n, built: 0, broadcasts: [], registered: true, failBroadcast: false, storage: fakeStorage(), vaultRegistered: false, vaultLamports: 0n, regBuilt: 0, calls: 0, rentFails: false, balanceFails: false };
  const client = {
    commitment: 'confirmed',
    proofService: {},
    getBalance: async () => {
      net.calls += 1;
      if (net.balanceFails) throw new Error('rpc unreachable');
      return net.vaultLamports;
    },
    solanaRpc: {
      getMinimumBalanceForRentExemption: (size) => ({
        send: async () => {
          if (net.rentFails) throw new Error('rpc unreachable');
          return (128n + BigInt(size)) * 6960n;
        },
      }),
      getSignatureStatuses: ([sig]) => ({ send: async () => ({ value: [net.statuses.get(sig) || null] }) }),
      getBlockHeight: () => ({ send: async () => net.finalizedHeight }),
    },
    confirmTransaction: async (sig) => {
      const st = net.statuses.get(sig);
      if (!st) throw new Error('confirmation timed out');
      return BigInt(st.slot);
    },
  };
  net.deps = {
    initializePoseidon,
    createSprClient: async () => client,
    syncWallet: async () => ({}),
    proofKeys: () => ({}),
    isWalletRegistered: async ({ owner }) => {
      net.calls += 1;
      return String(owner) === VAULT ? net.vaultRegistered : net.registered;
    },
    buildRegistrationTransaction: async ({ owner }) => {
      assert.equal(String(owner), VAULT);
      net.regBuilt += 1;
      return { n: 100 + net.regBuilt, registration: true };
    },
    buildTransferTransaction: async (input) => {
      net.built += 1;
      return { n: net.built, amount: input.amount, recipient: String(input.recipient) };
    },
    buildWithdrawalTransaction: async (input) => {
      net.built += 1;
      net.withdrawalsBuilt = (net.withdrawalsBuilt || 0) + 1;
      return { n: net.built, amount: input.amount, recipient: String(input.recipient), withdrawal: true };
    },
    sign: async (_signer, unsigned) => ({ signed: unsigned, signature: 'sig' + unsigned.n, lastValidBlockHeight: '150' }),
    broadcast: async (_c, signed) => {
      net.broadcasts.push('sig' + signed.n);
      net.seenAtBroadcast = await net.storage.kvGet(KV_SEND, net.key);
      if (net.failBroadcast) throw new Error('socket hang up');
      net.statuses.set('sig' + signed.n, { slot: 7000 + signed.n, err: null, confirmationStatus: 'confirmed' });
      if (signed.registration) net.vaultRegistered = true;
    },
  };
  net.rings = createRealRings(base, { storage: net.storage, deps: net.deps });
  return net;
}
const send = (net, key = 'wd1') => {
  net.key = key;
  return net.rings.sendPrivate({ to: BOB, asset: 'SOL', amount: 400n, memo: 'wd:' + key, idempotencyKey: key });
};

test('real send: record is written before the broadcast, second call returns the first result', async () => {
  const net = fakeNet();
  const r1 = await send(net);
  assert.deepEqual(r1, { signature: 'sig1', slot: 7001 });
  assert.equal(net.seenAtBroadcast.status, 'submitted');
  assert.equal(net.seenAtBroadcast.signature, 'sig1');
  assert.deepEqual(await send(net), r1);
  assert.equal(net.built, 1);
  assert.deepEqual(net.broadcasts, ['sig1']);
  assert.equal((await net.storage.kvGet(KV_SEND, 'wd1')).status, 'confirmed');
});

test('real send: landed but never recorded as confirmed, a restart finds it and does not pay again', async () => {
  const net = fakeNet();
  net.failBroadcast = true;
  await assert.rejects(send(net), (e) => e.code === 'SEND_UNCONFIRMED' && !e.permanent);
  net.statuses.set('sig1', { slot: 7001, err: null, confirmationStatus: 'finalized' }); // it did land
  const restarted = createRealRings(base, { storage: net.storage, deps: net.deps });
  net.registered = false; // even if the recipient changed since
  const r = await restarted.sendPrivate({ to: BOB, asset: 'SOL', amount: 400n, idempotencyKey: 'wd1' });
  assert.deepEqual(r, { signature: 'sig1', slot: 7001 });
  assert.equal(net.built, 1);
});

test('real send: an unresolved earlier attempt blocks a new one until its blockhash is dead', async () => {
  const net = fakeNet();
  net.failBroadcast = true;
  await assert.rejects(send(net), /not confirmed/);
  net.failBroadcast = false;
  net.finalizedHeight = 150n; // still valid
  await assert.rejects(send(net), (e) => e.code === 'SEND_PENDING' && !e.permanent);
  assert.equal(net.built, 1);
  net.statuses.set('sig1', { slot: 7001, err: null, confirmationStatus: 'processed' });
  net.finalizedHeight = 999n;
  await assert.rejects(send(net), (e) => e.code === 'SEND_PENDING');
  net.statuses.delete('sig1');
  const r = await send(net); // expired on the finalized chain: a new transfer is safe
  assert.deepEqual(r, { signature: 'sig2', slot: 7002 });
  assert.equal(net.built, 2);
  const rec = await net.storage.kvGet(KV_SEND, 'wd1');
  assert.deepEqual(rec.previous, ['sig1']);
  assert.equal(rec.attempt, 2);
});

test('real send: an attempt that failed on chain is rebuilt', async () => {
  const net = fakeNet();
  net.failBroadcast = true;
  await assert.rejects(send(net));
  net.failBroadcast = false;
  net.statuses.set('sig1', { slot: 7001, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' });
  assert.deepEqual(await send(net), { signature: 'sig2', slot: 7002 });
});

test('real send: permanent refusals happen before anything is built', async () => {
  const net = fakeNet();
  net.registered = false;
  await assert.rejects(send(net), (e) => e.permanent && e.code === 'RECIPIENT_NOT_REGISTERED');
  await assert.rejects(net.rings.sendPrivate({ to: 'nope', asset: 'SOL', amount: 1n, idempotencyKey: 'x' }), (e) => e.permanent && e.code === 'INVALID_ADDRESS');
  await assert.rejects(net.rings.sendPrivate({ to: BOB, asset: 'SOL', amount: 0n, idempotencyKey: 'y' }), (e) => e.permanent && e.code === 'INVALID_AMOUNT');
  await assert.rejects(net.rings.sendPrivate({ to: BOB, asset: 'SOL', amount: 1n }), /idempotencyKey/);
  assert.equal(net.built, 0);
  assert.equal(await net.storage.kvGet(KV_SEND, 'wd1'), null);
});

// ---------------------------------------------------------------- ensureReady (addendum A3)

const NEED = Number((128n + 100n) * 6960n + 128n * 6960n) + 10000; // rent(100) + rent(0) + fee margin = 2487760

test('real ensureReady: unfunded vault reports needs_funding with real numbers and sends nothing', async () => {
  const net = fakeNet();
  net.vaultLamports = 1_000_000n;
  const r = await net.rings.ensureReady();
  assert.deepEqual(r, { status: 'needs_funding', address: VAULT, haveLamports: 1000000, needLamports: NEED });
  assert.equal(NEED, 2487760);
  net.vaultLamports = BigInt(NEED) - 1n;
  assert.equal((await net.rings.ensureReady()).status, 'needs_funding');
  assert.equal(net.regBuilt, 0);
  assert.deepEqual(net.broadcasts, []);
  assert.equal(await net.storage.kvGet(KV_SEND, KV_REGISTRATION_KEY), null);
});

test('real ensureReady: cost falls back to the documented figure, and config.ringsRegisterLamports overrides', async () => {
  const net = fakeNet();
  net.rentFails = true;
  assert.deepEqual(await net.rings.ensureReady(), { status: 'needs_funding', address: VAULT, haveLamports: 0, needLamports: DEFAULT_REGISTER_LAMPORTS });
  assert.equal(DEFAULT_REGISTER_LAMPORTS, 3000000);
  const custom = createRealRings({ ...base, ringsRegisterLamports: 5_000_000 }, { storage: net.storage, deps: net.deps });
  net.vaultLamports = 4_999_999n;
  assert.deepEqual(await custom.ensureReady(), { status: 'needs_funding', address: VAULT, haveLamports: 4999999, needLamports: 5000000 });
});

test('real ensureReady: funded vault registers once, then answers ready without touching the network', async () => {
  const net = fakeNet();
  net.vaultLamports = BigInt(NEED);
  const first = await net.rings.ensureReady();
  assert.equal(first.status, 'ready');
  assert.equal(first.signature, 'sig101');
  assert.equal(net.regBuilt, 1);
  assert.deepEqual(net.broadcasts, ['sig101']);
  assert.equal((await net.storage.kvGet(KV_SEND, KV_REGISTRATION_KEY)).status, 'confirmed');
  const calls = net.calls;
  for (let i = 0; i < 5; i += 1) assert.deepEqual(await net.rings.ensureReady(), { status: 'ready' });
  assert.equal(net.calls, calls);
  assert.equal(net.regBuilt, 1);
  // a restart sees the record on chain and does not register again
  const restarted = createRealRings(base, { storage: net.storage, deps: net.deps });
  assert.deepEqual(await restarted.ensureReady(), { status: 'ready' });
  assert.equal(net.regBuilt, 1);
});

test('real ensureReady: concurrent calls share one registration', async () => {
  const net = fakeNet();
  net.vaultLamports = 50_000_000n;
  const results = await Promise.all([net.rings.ensureReady(), net.rings.ensureReady(), net.rings.ensureReady(), net.rings.ensureReady()]);
  assert.deepEqual(results.map((r) => r.status), ['ready', 'ready', 'ready', 'ready']);
  assert.equal(net.regBuilt, 1);
  assert.deepEqual(net.broadcasts, ['sig101']);
});

test('real ensureReady: an already registered vault is ready with no balance check and no transaction', async () => {
  const net = fakeNet();
  net.vaultRegistered = true;
  net.balanceFails = true;
  assert.deepEqual(await net.rings.ensureReady(), { status: 'ready' });
  assert.equal(net.regBuilt, 0);
});

test('real ensureReady: a registration with an unknown outcome is settled before another one is built', async () => {
  const net = fakeNet();
  net.vaultLamports = 50_000_000n;
  net.failBroadcast = true;
  const r1 = await net.rings.ensureReady();
  assert.equal(r1.status, 'error');
  assert.match(r1.message, /socket hang up/);
  assert.equal((await net.storage.kvGet(KV_SEND, KV_REGISTRATION_KEY)).status, 'submitted');
  net.failBroadcast = false;

  // still inside its blockhash window: wait, also after a restart
  net.finalizedHeight = 150n;
  const restarted = createRealRings(base, { storage: net.storage, deps: net.deps });
  for (const rings of [net.rings, restarted]) {
    const r = await rings.ensureReady();
    assert.equal(r.status, 'error');
    assert.match(r.message, /still confirming/);
  }
  assert.equal(net.regBuilt, 1);

  // it did land after all
  net.vaultRegistered = true;
  assert.deepEqual(await restarted.ensureReady(), { status: 'ready' });
  assert.equal(net.regBuilt, 1);
});

test('real ensureReady: a registration whose blockhash died is sent again, once', async () => {
  const net = fakeNet();
  net.vaultLamports = 50_000_000n;
  net.failBroadcast = true;
  assert.equal((await net.rings.ensureReady()).status, 'error');
  net.failBroadcast = false;
  net.finalizedHeight = 999n;
  const r = await net.rings.ensureReady();
  assert.equal(r.status, 'ready');
  assert.equal(net.regBuilt, 2);
  assert.deepEqual(net.broadcasts, ['sig101', 'sig102']);
});

test('real ensureReady: never throws', async () => {
  const net = fakeNet();
  net.balanceFails = true;
  assert.deepEqual(await net.rings.ensureReady(), { status: 'error', message: 'rpc unreachable' });
  net.balanceFails = false;
  net.vaultLamports = 50_000_000n;
  assert.equal((await net.rings.ensureReady()).status, 'ready');
});

test('real withdrawPublic: unshield to a public address, no registration needed, same exactly-once record', async () => {
  const net = fakeNet();
  net.registered = false; // a public address has no private wallet, and does not need one
  net.key = 'grad:c1';
  const r1 = await net.rings.withdrawPublic({ to: BOB, asset: 'SOL', amount: 85n, idempotencyKey: 'grad:c1' });
  assert.deepEqual(r1, { signature: 'sig1', slot: 7001 });
  assert.equal(net.withdrawalsBuilt, 1);
  assert.equal(net.seenAtBroadcast.status, 'submitted');
  assert.equal(net.seenAtBroadcast.kind, 'withdrawal');
  // a crash after it landed: a restart returns the first result and builds nothing
  const restarted = createRealRings(base, { storage: net.storage, deps: net.deps });
  assert.deepEqual(await restarted.withdrawPublic({ to: BOB, asset: 'SOL', amount: 85n, idempotencyKey: 'grad:c1' }), r1);
  assert.equal(net.built, 1);
  await assert.rejects(net.rings.withdrawPublic({ to: 'nope', asset: 'SOL', amount: 1n, idempotencyKey: 'grad:c2' }), (e) => e.code === 'INVALID_ADDRESS' && e.permanent);
  assert.equal(net.built, 1);
});

test('real send: too many small notes, the vault merges them, the retry pays once', async () => {
  const net = fakeNet();
  let tooMany = true;
  let merges = 0;
  let schemeSet = 0;
  net.deps.fetchUserRecord = async () => ({ mergeEncryption: schemeSet ? 1 : 0 });
  net.deps.buildSetMergeEncryptionTransaction = async () => {
    schemeSet += 1;
    net.built += 1;
    return { n: net.built, scheme: true };
  };
  net.deps.buildMergeTransaction = async () => {
    merges += 1;
    tooMany = false;
    net.built += 1;
    return { n: net.built, merge: true };
  };
  const realBuild = net.deps.buildWithdrawalTransaction;
  net.deps.buildWithdrawalTransaction = async (input) => {
    if (tooMany) throw new WalletError('WALLET_BUILD_WITHDRAWAL', { causeCode: 'WALLET_TOO_MANY_INPUTS' });
    return realBuild(input);
  };
  net.rings = createRealRings(base, { storage: net.storage, deps: net.deps });
  const args = { to: BOB, asset: 'SOL', amount: 400n, idempotencyKey: 'big1' };
  net.key = 'big1';
  await assert.rejects(net.rings.withdrawPublic(args), (e) => e.code === 'NOTES_MERGED' && !e.permanent);
  assert.equal(merges, 1);
  const r = await net.rings.withdrawPublic(args);
  assert.ok(r.signature);
  assert.equal(net.withdrawalsBuilt, 1);
  assert.deepEqual(await net.rings.withdrawPublic(args), r); // paid once
});
