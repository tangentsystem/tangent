import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModules } from './modules.js';
import { loadConfig } from '../config.js';
import { createMemoryStore } from '../storage/index.js';
import { ensureKeys } from '../keys.js';
import { createMemoryLogger } from './log.js';

const CA = 'So11111111111111111111111111111111111111112';
const notFound = (p) => { const e = new Error(`Cannot find module '/repo/src/${p.replace('../', '')}'`); e.code = 'ERR_MODULE_NOT_FOUND'; return e; };

async function ctx(env) {
  const config = loadConfig(env);
  const store = await createMemoryStore();
  const keys = await ensureKeys({ store });
  return { config, store, keys, log: createMemoryLogger(config) };
}

test('modules: empty env switches on nothing that needs config', async () => {
  const c = await ctx({});
  const seen = [];
  const m = await loadModules({ ...c, importer: async (p) => { seen.push(p); throw notFound(p); } });
  assert.deepEqual(seen, ['../offgrid/index.js', '../token/index.js']);
  assert.equal(m.pay, null);
  assert.equal(m.token, null);
  assert.deepEqual(m.status, { offgrid: 'missing', pay: 'off', token: 'missing' });
});

test('modules: pay needs both MONGO_URI and HELIUS_API_KEY, and gets the service Rings seed', async () => {
  const onlyHelius = await ctx({ HELIUS_API_KEY: 'abcd1234key' });
  let m = await loadModules({ ...onlyHelius, importer: async (p) => { throw notFound(p); } });
  assert.equal(m.status.pay, 'off');
  const both = await ctx({ HELIUS_API_KEY: 'abcd1234key', MONGO_URI: 'mongodb://h/x' });
  let got = null;
  m = await loadModules({
    ...both,
    importer: async (p) => {
      if (p.includes('pay')) {
        return {
          kvFromStore: (s) => ({ kv: s }),
          createRingsAdapter: async (cfg, { storage }) => ({ mode: cfg.ringsMode, seedLen: cfg.ringsSeed.length, storage }),
          createPay: async (args) => { got = args; return { router: null, redeemVoucher() {} }; },
        };
      }
      throw notFound(p);
    },
  });
  assert.equal(m.status.pay, 'on');
  assert.equal(got.store.kind, 'memory');
  assert.equal(typeof got.store.tx, 'function');
  assert.equal(typeof got.store.keys.insert, 'function');
  assert.equal(got.rings.mode, 'real');
  assert.equal(got.rings.seedLen, 32);
  assert.ok(got.rings.storage.kv);
  assert.equal(got.config.ringsNetwork, 'mainnet');
  // the nodes hooks read the registry's collection
  assert.equal(await got.nodes.isRegistered('nobody'), false);
  await both.store.collection('nodes').insert({ _id: 'n1', descriptor: { payout: 'P1' } });
  assert.equal(await got.nodes.isRegistered('n1'), true);
  assert.equal(await got.nodes.payoutAddress('n1'), 'P1');
});

test('modules: a module that throws on import or start is reported and the rest still loads', async () => {
  const c = await ctx({ HELIUS_API_KEY: 'abcd1234key', MONGO_URI: 'mongodb://h/x', TOKEN_CA: CA });
  const m = await loadModules({
    ...c,
    connection: { fake: true },
    importer: async (p) => {
      if (p.includes('offgrid')) throw new SyntaxError('Unexpected token in offgrid');
      if (p.includes('pay')) return { createRingsAdapter: async () => ({}), createPay: async () => { throw new Error('rings down'); } };
      return { createToken: async ({ ca }) => ({ ca, router: null }) };
    },
  });
  assert.deepEqual(m.status, { offgrid: 'failed', pay: 'failed', token: 'on' });
  assert.equal(m.token.ca, CA);
  assert.match(c.log.lines.join('\n'), /module.start_failed.*rings down/);
});

test('modules: token without a connection is built with connection null', async () => {
  const c = await ctx({ TOKEN_CA: CA });
  let seen;
  const m = await loadModules({ ...c, importer: async (p) => { if (p.includes('token')) return { createToken: async (o) => { seen = o; return {}; } }; throw notFound(p); } });
  assert.equal(m.status.token, 'on');
  assert.equal(seen.connection, null);
  assert.equal(seen.ca, CA);
});
