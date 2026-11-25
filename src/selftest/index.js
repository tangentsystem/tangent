// Self test on deploy. Runs by itself when the service boots with MONGO_URI and HELIUS_API_KEY
// (no other setting, no admin secret). See docs/selftest.md.
//
//   createServiceSelfTest({ config, store, keys, connection, log, env }) -> runner | null
//
// null means the self test does not apply (memory storage or no Helius key): pay is off in that
// case anyway, so there is no money to gate.
import { createSelfTest } from './runner.js';
import { createRealWorld, buildVersion } from './world.js';
import { PRODUCT_NAME } from '../config.js';

export { createSelfTest, SELFTEST_DEFAULTS } from './runner.js';
export { STATUS, formatBlock, summaryOf } from './report.js';
export { buildVersion, fundingPlan, tipLamportsFor, METEORA_FIXTURE, PUMPFUN_FIXTURES, RAYDIUM_FIXTURES, AMOUNTS } from './world.js';
export { createMoneyGuard, MoneyRuleError } from './guard.js';

export function selftestApplies(config, store) {
  return Boolean(config && config.flags && config.flags.mongo && config.flags.helius && store && store.kind === 'mongo');
}

export async function createServiceSelfTest({ config, store, keys, connection, log, env = process.env, timing = {}, deps = {} }) {
  if (!selftestApplies(config, store) || !connection) return null;
  const world = await createRealWorld({ config, store, keys, connection, log, deps });
  const build = buildVersion(config, env);
  log.info('selftest.wallet', { address: world.wallet.address, explorer: world.wallet.link, note: 'self test wallet: created by this service, insert only with a backup row' });
  return createSelfTest({
    config, store, log, build, product: PRODUCT_NAME,
    freeChecks: world.freeChecks, funded: world.funded, timing,
  });
}
