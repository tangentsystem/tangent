// Memo carrying deposit notes must stay spendable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initializePoseidon, ShieldedKeypair, SigningKey, Utxo, Data, SOL_MINT, Wallet } from '@heliuslabs/spr';
import { AssetRegistry } from '@heliuslabs/spr/transaction';
import { isPlainUtxo } from '../../../node_modules/@heliuslabs/spr/dist/flows/select.js';
import { liftMemoNotes } from './real.js';

test('a deposit note with a memo becomes spendable, same hash, memo kept', async () => {
  await initializePoseidon();
  const kp = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(new Uint8Array(32).fill(7)));
  const addr = kp.shieldedAddress();
  const blinding = new Uint8Array(32).fill(3);
  blinding[0] = 0;
  const memo = new TextEncoder().encode('tangent:abc');
  const utxo = new Utxo({ owner: addr.signingPublicKey, asset: SOL_MINT, amount: 20000000n, blinding, data: new Data([{ kind: 'memo', bytes: memo }]) });
  const hash = utxo.hash(addr.nullifierPublicKey, 0);
  const w = new Wallet({ identity: addr, registry: new AssetRegistry() });
  const entry = { utxo, outputContext: { hash, tree: 0, leafIndex: 42n }, nullifier: new Uint8Array(32).fill(9), spent: false };
  const st = w._state();
  w._replace({ utxos: [entry], transactions: st.transactions, nullifiers: st.nullifiers });
  assert.equal(isPlainUtxo(w.utxos()[0]), false);

  const cache = new Map();
  liftMemoNotes(w, cache);
  const after = w.utxos()[0];
  assert.equal(isPlainUtxo(after), true);
  assert.equal(after.utxo.amount, 20000000n);
  assert.ok(Buffer.from(after.utxo.hash(addr.nullifierPublicKey, 0)).equals(Buffer.from(hash)));
  assert.ok(Buffer.from(after.outputContext.hash).equals(Buffer.from(hash)));
  assert.equal(new TextDecoder().decode(cache.get('42')), 'tangent:abc');
});

test('the real SDK payout build refuses a memo note before the fix and accepts it after', async () => {
  const { buildWithdrawalTransaction } = await import('@heliuslabs/spr');
  const { classifySdkError } = await import('./real.js');
  await initializePoseidon();
  const kp = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(new Uint8Array(32).fill(7)));
  const addr = kp.shieldedAddress();
  const mk = () => {
    const blinding = new Uint8Array(32).fill(3);
    blinding[0] = 0;
    const utxo = new Utxo({ owner: addr.signingPublicKey, asset: SOL_MINT, amount: 20000000n, blinding, data: new Data([{ kind: 'memo', bytes: new TextEncoder().encode('tangent:abc') }]) });
    const w = new Wallet({ identity: addr, registry: new AssetRegistry() });
    const st = w._state();
    w._replace({ utxos: [{ utxo, outputContext: { hash: utxo.hash(addr.nullifierPublicKey, 0), tree: 0, leafIndex: 42n }, nullifier: new Uint8Array(32).fill(9), spent: false }], transactions: st.transactions, nullifiers: st.nullifiers });
    return w;
  };
  const attempt = async (w) => {
    try {
      await buildWithdrawalTransaction({ client: {}, wallet: w, keys: {}, feePayer: kp.toSolanaSigner().address, recipient: '93Fbm9p6272u9LXeRgqjFikuAeSDWwuWsSVza2KRZVGv', asset: SOL_MINT, amount: 15000000n });
      return 'built';
    } catch (e) {
      return classifySdkError(e).code;
    }
  };
  assert.equal(await attempt(mk()), 'INSUFFICIENT_VAULT_BALANCE'); // the exact live error
  assert.notEqual(await attempt(liftMemoNotes(mk())), 'INSUFFICIENT_VAULT_BALANCE'); // past coin selection, on to proving
});
