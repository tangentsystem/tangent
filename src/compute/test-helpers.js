// Test helpers (not a test file): a node API on an ephemeral port and a fake payer.
import express from 'express';
import { createIdentity } from '../core/identity.js';
import { createMeter } from '../core/meter.js';
import { createCompute } from './index.js';

export async function startNode({ driver, onVoucher, ...opts }) {
  const identity = createIdentity();
  const meter = createMeter();
  const accepted = [];
  const compute = createCompute({
    identity, driver, meter,
    onVoucher: onVoucher || (async (v) => { accepted.push(v); return { ok: true }; }),
    browser: { allowPrivateNetwork: true },
    ...opts,
  });
  await compute.start();
  const app = express();
  app.use('/api/compute', compute.router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/compute/`;
  return {
    identity, meter, compute, accepted, url, server,
    async close() { await compute.stop(); server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())); },
  };
}

// Fake payer: one throwaway identity per node, a fixed balance.
export function fakePayer({ lamports = 10_000_000_000n } = {}) {
  const ids = new Map();
  return {
    identityFor(nodeId) { if (!ids.has(nodeId)) ids.set(nodeId, createIdentity()); return ids.get(nodeId); },
    async balance() { return { lamports: lamports.toString() }; },
  };
}

export async function startPage(html) {
  const app = express();
  app.get('/', (req, res) => res.type('html').send(html));
  app.get('/next', (req, res) => res.type('html').send('<html><head><title>Next</title></head><body><p id="t">second page</p></body></html>'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
