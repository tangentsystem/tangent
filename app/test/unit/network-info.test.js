import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkInfo } from '../../core/network.js';

const CA = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
function fakeFetch(body, status = 200) { return async () => ({ ok: status < 400, status, json: async () => body }); }
const coord = { base: 'http://c', directory: async () => [], map: async () => ({ nodes: [] }) };

test('the token block shows only when the coordinator reports a symbol and an address', async () => {
  const full = await createNetworkInfo({ coord, fetch: fakeFetch({ configured: true, ca: CA, symbol: 'TANGENT', buyUrl: 'https://pump.fun/coin/' + CA }) }).token();
  assert.deepEqual(full, { symbol: 'TANGENT', ca: CA, buyUrl: 'https://pump.fun/coin/' + CA, explorer: `https://solscan.io/token/${CA}` });
  const noBuy = await createNetworkInfo({ coord, fetch: fakeFetch({ configured: true, ca: CA, symbol: 'TANGENT', buyUrl: null }) }).token();
  assert.equal(noBuy.buyUrl, null);
  for (const body of [{ configured: false }, { configured: true, ca: CA, symbol: null }, { configured: true, ca: null, symbol: 'TANGENT' }, { configured: true, ca: 'not an address', symbol: 'X' }]) {
    assert.equal(await createNetworkInfo({ coord, fetch: fakeFetch(body) }).token(), null, JSON.stringify(body));
  }
  assert.equal(await createNetworkInfo({ coord, fetch: fakeFetch({ error: 'NOT_CONFIGURED' }, 503) }).token(), null);
  assert.equal(await createNetworkInfo({ coord, fetch: async () => { throw new Error('offline'); } }).token(), null);
  const js = await createNetworkInfo({ coord, fetch: fakeFetch({ configured: true, ca: CA, symbol: 'T', buyUrl: 'javascript:alert(1)' }) }).token();
  assert.equal(js.buyUrl, null, 'only https buy links');
});

test('nodes: roles in a fixed order with region and link, no addresses', async () => {
  const c = {
    base: 'http://c',
    directory: async () => [{ id: 'N1', roles: ['relay', 'compute'], host: '10.0.0.1', port: 1, prices: { perMbLamports: '10000' } }, { id: 'N2', roles: ['relay', 'exit', 'gateway'], host: '10.0.0.2', port: 2 }],
    map: async () => ({ nodes: [{ id: 'N1', region: 'eu', link: 'https://solscan.io/account/N1' }] }),
  };
  const n = await createNetworkInfo({ coord: c, fetch: fakeFetch({}) }).nodes();
  assert.deepEqual(n.map((x) => x.roles), [['relay', 'compute'], ['exit', 'relay', 'gateway']]);
  assert.equal(n[0].region, 'eu');
  assert.equal(n[1].link, 'https://solscan.io/account/N2');
  assert.ok(n.every((x) => x.host === undefined && x.port === undefined));
});
