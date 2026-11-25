// Driver selection. docker is the default when a daemon is reachable. The process
// driver is development only, NOT sealed, and only used when asked for with dev: true.
import { createDockerDriver } from './docker.js';
import { createProcessDriver } from './process.js';

export { createDockerDriver, createProcessDriver };
export { DEFAULT_SIZES } from './common.js';
export { DEFAULT_IMAGES } from './docker.js';

export async function pickDriver({ prefer = 'docker', dev = false, docker = {}, process: proc = {}, log = () => {} } = {}) {
  if (prefer === 'docker') {
    const d = createDockerDriver({ ...docker, log });
    const c = await d.check();
    if (c.ok) return d;
    if (!dev) throw new Error(`no Docker daemon reachable (${c.reason}); the process driver needs an explicit dev flag`);
    log('compute.driver.fallback', { reason: c.reason, driver: 'process', sealed: false });
  }
  return createProcessDriver({ ...proc, dev, log });
}
