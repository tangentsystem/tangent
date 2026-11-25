// Rings adapter factory. Real adapter (@heliuslabs/spr) when config.ringsMode === 'real', sim otherwise.
// Both expose: mode, vaultAddress(), listIncoming({ cursor, limit }), sendPrivate({ to, asset, amount, memo, idempotencyKey }),
// withdrawPublic({ to, asset, amount, idempotencyKey }), buildPublicDeposit({ from, amount, creditTo }),
// vaultBalance(asset), ensureReady(). The sim also exposes adapter.sim.* helpers for tests.
//
// The real adapter needs a small key value store for its exactly-once send records: { kvGet(ns, key), kvSet(ns, key, value) }.
// kvFromStore(store) (src/pay/store.js) builds one on the pay store.
import { createSimRings } from './sim.js';

export { RingsError, isPermanent, PERMANENT_CODES } from './errors.js';
export { createSimRings, simVaultAddress } from './sim.js';
export { DEFAULT_MEMO_PREFIX, memoTarget, planDeposit } from './memo.js';

export async function createRingsAdapter(config = {}, { storage } = {}) {
  if (config.ringsMode === 'real') {
    // Loaded lazily so a sim boot never touches the SDK.
    const { createRealRings } = await import('./real.js');
    return createRealRings(config, { storage });
  }
  return createSimRings(config);
}
