// Plugs the other modules into the service. Every import is dynamic and guarded,
// so the service still boots when a module is missing, broken or not configured;
// that module then answers 503 NOT_CONFIGURED.
//
//   offgrid  src/offgrid/index.js  checkClaim + splitTip for /api/offgrid/claim (no config needed)
//   pay      src/pay/index.js      createRingsAdapter + createPay({ store, rings, config, log, nodes }) on the pay
//                                  shaped store (src/storage/pay-store.js); only with MONGO_URI and HELIUS_API_KEY,
//                                  because balances are real money and must survive a restart
//   token    src/token/index.js    createToken({ connection, ca, log }); with TOKEN_CA. connection is the
//                                  Helius (or SOLANA_RPC_URL) Connection, or null when none is set: the token
//                                  layer then answers configured, not available, reason no_connection
//   pay (dev) PAY_DEV_SIM=true and no real pay config: pay on the simulated Rings adapter (no real money)
//
// The real Rings adapter gets the service's own Rings wallet seed (src/keys.js).
import { createPayStore } from '../storage/pay-store.js';

const PATHS = Object.freeze({ offgrid: '../offgrid/index.js', pay: '../pay/index.js', token: '../token/index.js' });

function missing(err, path) {
  return err && err.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(path.replace('../', '/'));
}

export async function createConnection(config, importer = (p) => import(p)) {
  if (!config.solanaRpcUrl) return null;
  const web3 = await importer('@solana/web3.js');
  return new web3.Connection(config.solanaRpcUrl, 'confirmed');
}

export async function loadModules({ config, store, keys, log, connection = null, importer = (p) => import(p) }) {
  const status = { offgrid: 'off', pay: 'off', token: 'off' };
  const out = { offgrid: null, pay: null, token: null, rings: null, status };
  const reason = (err) => String((err && err.message) || err).slice(0, 160);

  async function load(name) {
    try {
      return await importer(PATHS[name]);
    } catch (err) {
      if (missing(err, PATHS[name])) { status[name] = 'missing'; return null; }
      status[name] = 'failed';
      log.warn('module.load_failed', { module: name, reason: reason(err) });
      return null;
    }
  }

  const off = await load('offgrid');
  if (off && typeof off.checkClaim === 'function') {
    out.offgrid = { checkClaim: off.checkClaim, splitTip: typeof off.splitTip === 'function' ? off.splitTip : undefined, bundleIdOfTx: typeof off.bundleIdOfTx === 'function' ? off.bundleIdOfTx : undefined };
    status.offgrid = 'on';
  } else if (off) status.offgrid = 'failed';

  if (config.flags.mongo && config.flags.helius) {
    const mod = await load('pay');
    if (mod && typeof mod.createPay === 'function' && typeof mod.createRingsAdapter === 'function') {
      try {
        const payStore = createPayStore(store);
        const nodes = store.collection('nodes');
        const ringsConfig = {
          ...config,
          ringsMode: 'real',
          ringsSeed: keys.rings.seed,
          ringsNetwork: config.solanaCluster === 'devnet' ? 'devnet' : 'mainnet',
          tipSweepFrom: keys.tip.address, // tip sweeps into the vault credit no wallet (src/coord/tip-sweep.js)
        };
        const storage = typeof mod.kvFromStore === 'function' ? mod.kvFromStore(payStore) : undefined;
        out.rings = await mod.createRingsAdapter(ringsConfig, { storage });
        out.pay = await mod.createPay({
          store: payStore,
          rings: out.rings,
          config: ringsConfig,
          log: (event, fields) => log.info(event, fields || {}),
          nodes: {
            isRegistered: async (id) => Boolean(typeof id === 'string' && id && (await nodes.get(id))),
            payoutAddress: async (id) => { const n = typeof id === 'string' && id ? await nodes.get(id) : null; return n ? n.descriptor.payout : null; },
          },
        });
        status.pay = 'on';
      } catch (err) {
        status.pay = 'failed';
        out.pay = null;
        log.warn('module.start_failed', { module: 'pay', reason: reason(err) });
      }
    } else if (mod) status.pay = 'failed';
  }

  if (!out.pay && config.payDevSim && !(config.flags.mongo && config.flags.helius)) {
    const mod = await load('pay');
    if (mod && typeof mod.createPay === 'function' && typeof mod.createSimRings === 'function') {
      try {
        const payStore = createPayStore(store);
        const nodes = store.collection('nodes');
        out.rings = mod.createSimRings({ ringsSeed: keys.rings.seed });
        out.pay = await mod.createPay({
          store: payStore,
          rings: out.rings,
          config: { ...config, ringsMode: 'sim', tipSweepFrom: keys.tip.address, payExposeSim: config.payDevSimRoutes === true },
          log: (event, fields) => log.info(event, fields || {}),
          nodes: {
            isRegistered: async (id) => Boolean(typeof id === 'string' && id && (await nodes.get(id))),
            payoutAddress: async (id) => { const n = typeof id === 'string' && id ? await nodes.get(id) : null; return n ? n.descriptor.payout : null; },
          },
        });
        status.pay = 'sim';
        log.warn('pay.dev_sim', { note: 'PAY_DEV_SIM is on: pay runs on the simulated Rings adapter, balances are not real money' });
      } catch (err) {
        status.pay = 'failed';
        out.pay = null;
        log.warn('module.start_failed', { module: 'pay', reason: reason(err) });
      }
    } else if (mod) status.pay = 'failed';
  }

  // Always built (docs/token.md): with no TOKEN_CA it answers only { configured: false } and
  // reads nothing from chain; status stays 'off' until TOKEN_CA is set.
  {
    const mod = await load('token');
    if (mod && typeof mod.createToken === 'function') {
      try {
        out.token = await mod.createToken({ connection, ca: config.flags.token ? config.tokenCa : '', log });
        status.token = config.flags.token ? 'on' : 'off';
      } catch (err) {
        status.token = 'failed';
        log.warn('module.start_failed', { module: 'token', reason: reason(err) });
      }
    } else if (mod) status.token = 'failed';
  }
  return out;
}
