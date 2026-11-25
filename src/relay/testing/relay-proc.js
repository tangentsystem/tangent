// Runs one relay in its own process for the multi process test.
// argv[2] = JSON { roles, perMbLamports, allowPrivateTargets }. Prints the signed descriptor
// as one JSON line on stdout once listening.
import { createIdentity, createKxKeypair, signDescriptor } from '../../core/index.js';
import { createRelay } from '../relay.js';

const cfg = JSON.parse(process.argv[2] || '{}');
const roles = cfg.roles || ['relay'];
const identity = createIdentity();
const kx = createKxKeypair();
const relay = createRelay({
  identity, kx, host: '127.0.0.1', port: 0, exit: roles.includes('exit'),
  allowPrivateTargets: !!cfg.allowPrivateTargets, allowPrivateRelays: true,
  onVoucher: async () => ({ ok: true }),
});
await relay.start();
const d = signDescriptor(identity, { roles, host: '127.0.0.1', port: relay.port, kx: kx.pub, prices: { perMbLamports: BigInt(cfg.perMbLamports || 0) } });
relay.setDescriptor(d);
process.stdout.write(JSON.stringify(d) + '\n');
process.on('SIGTERM', async () => { await relay.stop(); process.exit(0); });
