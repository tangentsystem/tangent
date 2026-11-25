// Shared driver pieces: machine sizes and path rules.
import path from 'node:path';

// price multiplier is applied to the node's base perSecondLamports
export const DEFAULT_SIZES = Object.freeze({
  small: Object.freeze({ cpus: 0.5, memoryMb: 256, pids: 256, diskMb: 256, priceMultiplier: 1n }),
  medium: Object.freeze({ cpus: 1, memoryMb: 1024, pids: 512, diskMb: 1024, priceMultiplier: 2n }),
  large: Object.freeze({ cpus: 2, memoryMb: 2048, pids: 1024, diskMb: 4096, priceMultiplier: 4n }),
});

// Machine paths are POSIX. Relative paths are inside the work dir. Absolute paths
// must stay inside one of `roots`. Returns the normalized absolute path or throws.
export function machinePath(p, { workDir, roots }) {
  if (typeof p !== 'string' || !p.length || p.length > 1024 || p.includes('\0')) throw badPath('bad path');
  const abs = path.posix.normalize(p.startsWith('/') ? p : path.posix.join(workDir, p));
  if (!roots.some((r) => abs === r || abs.startsWith(r.endsWith('/') ? r : r + '/'))) throw badPath(`path must be inside ${roots.join(' or ')}`);
  if (roots.includes(abs)) throw badPath('path is a directory');
  return abs;
}

function badPath(msg) { const e = new Error(msg); e.status = 400; return e; }

export class ExecLimitError extends Error {}
