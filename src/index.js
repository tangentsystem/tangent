// Entry point (npm start). Boots the coordinator service and shuts it down
// cleanly on SIGTERM / SIGINT. A config error names the variable and exits 1.
import { startService } from './coord/service.js';

let service = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (service) service.log.info('service.stopping', { signal });
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try {
    if (service) await service.stop();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  service = await startService();
} catch (err) {
  const msg = err && err.code === 'BAD_CONFIG' ? err.message : 'boot failed: ' + String((err && err.message) || err).replace(/mongodb(\+srv)?:\/\/\S+/gi, 'mongodb://[hidden]').replace(/api[-_]?key=[^&\s"']+/gi, 'api-key=[hidden]');
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), level: 'error', event: 'service.boot_failed', reason: msg.slice(0, 300) }) + '\n');
  process.exit(1);
}
