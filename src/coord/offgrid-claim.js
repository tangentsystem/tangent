// Off grid tip claims (POST /api/offgrid/claim). A transaction that travelled
// device to device and was submitted by a gateway may carry a tip to the network
// tip account. The gateway and the carriers on its trail claim their shares,
// once per transaction.
//
// Wire format and signature checks are src/offgrid's (buildClaim / checkClaim /
// splitTip in src/offgrid/receipt.js), handed to createApp as `offgrid`:
//   { v: 1, t: <claim tag set by src/offgrid>, role, claimant, bundleId, signature, slot, gateway,
//     trail: [{ node, sig }], receipt, ts, sig }
// This file adds what only the coordinator can check: the transaction on chain
// and the lamports it paid to the tip account. The splitTip below is a fallback
// with the same rule and output shape, used only if src/offgrid has none.

export const MAX_CARRIERS_PAID = 8;

// Half to the gateway, half shared evenly by up to 8 distinct carriers in trail
// order (gateway excluded), rounding dust to the gateway; no carriers: all to the gateway.
// -> { gateway: { id, lamports }, carriers: [{ id, lamports }] }
export function splitTip(tipLamports, trail, gateway) {
  const tip = BigInt(tipLamports);
  if (tip < 0n) throw new Error('splitTip: negative tip');
  const carriers = [];
  for (const e of trail || []) {
    const id = typeof e === 'string' ? e : e.node;
    if (id && id !== gateway && !carriers.includes(id)) carriers.push(id);
    if (carriers.length >= MAX_CARRIERS_PAID) break;
  }
  if (!carriers.length) return { gateway: { id: gateway, lamports: tip }, carriers: [] };
  const gw = tip / 2n;
  const each = (tip - gw) / BigInt(carriers.length);
  return { gateway: { id: gateway, lamports: tip - each * BigInt(carriers.length) }, carriers: carriers.map((id) => ({ id, lamports: each })) };
}

// Raw wire bytes of a landed transaction, when the connection can give them:
// connection.getRawTransaction(signature) (tests, adapters) or the JSON RPC
// getTransaction with base64 encoding (@solana/web3.js Connection._rpcRequest).
// -> Uint8Array | null (null when the connection offers neither)
export async function rawTxBytes(connection, signature) {
  if (connection && typeof connection.getRawTransaction === 'function') {
    const b = await connection.getRawTransaction(signature);
    return b ? Uint8Array.from(b) : null;
  }
  if (connection && typeof connection._rpcRequest === 'function') {
    const r = await connection._rpcRequest('getTransaction', [signature, { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
    const data = r && r.result && r.result.transaction;
    if (Array.isArray(data) && typeof data[0] === 'string') return Uint8Array.from(Buffer.from(data[0], 'base64'));
    return null;
  }
  return null;
}

function keyText(k) {
  if (typeof k === 'string') return k;
  if (k && typeof k.toBase58 === 'function') return k.toBase58();
  if (k && typeof k.pubkey !== 'undefined') return keyText(k.pubkey);
  return String(k);
}

// Account keys of a getTransaction result, in index order (static keys, then
// loaded writable, then loaded readonly), for legacy and v0 messages.
export function accountKeysOf(tx) {
  const msg = tx && tx.transaction && tx.transaction.message;
  if (!msg) return [];
  const statics = msg.staticAccountKeys || msg.accountKeys || [];
  const loaded = (tx.meta && tx.meta.loadedAddresses) || { writable: [], readonly: [] };
  return [...statics, ...(loaded.writable || []), ...(loaded.readonly || [])].map(keyText);
}

// Lamports the transaction moved into `account` (post minus pre balance), 0n if none.
export function lamportsReceived(tx, account) {
  const keys = accountKeysOf(tx);
  const i = keys.indexOf(account);
  if (i < 0 || !tx.meta || !Array.isArray(tx.meta.preBalances) || !Array.isArray(tx.meta.postBalances)) return 0n;
  const d = BigInt(tx.meta.postBalances[i] ?? 0) - BigInt(tx.meta.preBalances[i] ?? 0);
  return d > 0n ? d : 0n;
}
