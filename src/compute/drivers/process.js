// Process driver: DEVELOPMENT ONLY. NOT SEALED.
// A "machine" is a working directory on the host and every command is a plain child
// process of the node, run as the node's own user, with rlimits through `prlimit`
// when it exists. Commands can read the host file system, reach the host network and
// see other processes. Never offer this to the public. It refuses to start unless
// created with { dev: true }.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SIZES, machinePath } from './common.js';

const WORK = '/work';
const TMP = '/tmp';

function hasPrlimit() {
  try { return spawnSync('prlimit', ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
}

export function createProcessDriver({ dev = false, rootDir, sizes = DEFAULT_SIZES, log = () => {} } = {}) {
  if (dev !== true) {
    throw new Error('process driver is for development only and is NOT sealed (commands run on the host as the node user). Pass { dev: true } to use it.');
  }
  const base = rootDir || path.join(os.tmpdir(), 'tangent-compute-dev');
  const prlimit = hasPrlimit();
  const machines = new Map();

  function hostPath(m, p) {
    const abs = machinePath(p, { workDir: WORK, roots: [WORK, TMP] });
    const rel = abs.startsWith(WORK + '/') ? abs.slice(WORK.length + 1) : '.tmp/' + abs.slice(TMP.length + 1);
    return path.join(m.dir, rel);
  }

  async function confined(m, hp) {
    const parent = path.dirname(hp);
    const real = await fs.realpath(parent);
    const root = await fs.realpath(m.dir);
    if (real !== root && !real.startsWith(root + path.sep)) { const e = new Error('path escapes the machine'); e.status = 400; throw e; }
    const target = path.join(real, path.basename(hp));
    try {
      const st = await fs.lstat(target);
      if (st.isSymbolicLink()) { const e = new Error('symlinks are not followed'); e.status = 400; throw e; }
      if (st.isDirectory()) { const e = new Error('path is a directory'); e.status = 400; throw e; }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return target;
  }

  return {
    name: 'process',
    sealed: false,
    description: 'development only, NOT sealed: commands run as host processes',
    sizes,
    imageNames: ['host'],
    async images() { return ['host']; },
    async cleanup() { return 0; },
    async check() { return { ok: true, sealed: false, prlimit }; },
    async create({ id, size, egress }) {
      const spec = sizes[size];
      if (!spec) throw new Error('unknown size');
      const dir = path.join(base, id);
      await fs.mkdir(path.join(dir, '.tmp'), { recursive: true, mode: 0o700 });
      const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dir, TMPDIR: path.join(dir, '.tmp'), LANG: 'C.UTF-8' };
      if (egress) {
        // advisory only: nothing stops a process from ignoring these variables
        const u = `socks5h://${egress.socksHost}:${egress.socksPort}`;
        Object.assign(env, { ALL_PROXY: u, all_proxy: u, HTTPS_PROXY: u, https_proxy: u, HTTP_PROXY: u, http_proxy: u });
      }
      const m = { id, dir, spec, env, execs: new Set(), paused: false };
      machines.set(id, m);
      log('compute.process.create', { id });
      return m;
    },
    exec(m, { cmd, stdin, timeoutMs, onStdout, onStderr }) {
      if (m.paused) throw Object.assign(new Error('machine is paused'), { status: 402 });
      const started = Date.now();
      const asBytes = m.spec.memoryMb * 4 * 1024 * 1024; // address space, not resident memory
      const fsize = m.spec.diskMb * 1024 * 1024;
      const argv = prlimit
        ? ['prlimit', [`--as=${asBytes}`, `--fsize=${fsize}`, '--nofile=256', '--core=0', '--', 'sh', '-c', cmd]]
        : ['sh', ['-c', cmd]];
      const child = spawn(argv[0], argv[1], { cwd: m.dir, env: m.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      m.execs.add(child);
      let timedOut = false;
      const killTree = (sig) => { try { process.kill(-child.pid, sig); } catch {} };
      const timer = setTimeout(() => { timedOut = true; killTree('SIGCONT'); killTree('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', (b) => onStdout && onStdout(b));
      child.stderr.on('data', (b) => onStderr && onStderr(b));
      child.stdin.on('error', () => {});
      if (stdin) child.stdin.end(stdin); else child.stdin.end();
      const done = new Promise((resolve) => {
        child.on('error', (e) => { onStderr && onStderr(Buffer.from(String(e.message) + '\n')); });
        child.on('close', (code, signal) => {
          clearTimeout(timer); m.execs.delete(child);
          resolve({ exitCode: code, signal: signal || null, timedOut, durationMs: Date.now() - started });
        });
      });
      return { done, kill: () => killTree('SIGKILL') };
    },
    async writeFile(m, p, data) {
      const hp = hostPath(m, p);
      await fs.mkdir(path.dirname(hp), { recursive: true });
      const target = await confined(m, hp);
      if (data.length > m.spec.diskMb * 1024 * 1024) throw Object.assign(new Error('file too large for this machine'), { status: 413 });
      await fs.writeFile(target, data);
    },
    async readFile(m, p, maxBytes) {
      const target = await confined(m, hostPath(m, p));
      const st = await fs.stat(target).catch(() => null);
      if (!st) throw Object.assign(new Error('no such file'), { status: 404 });
      if (st.size > maxBytes) throw Object.assign(new Error('file too large to read'), { status: 413 });
      return fs.readFile(target);
    },
    async pause(m) { m.paused = true; for (const c of m.execs) { try { process.kill(-c.pid, 'SIGSTOP'); } catch {} } },
    async resume(m) { m.paused = false; for (const c of m.execs) { try { process.kill(-c.pid, 'SIGCONT'); } catch {} } },
    async destroy(m) {
      for (const c of m.execs) { try { process.kill(-c.pid, 'SIGCONT'); process.kill(-c.pid, 'SIGKILL'); } catch {} }
      m.execs.clear();
      machines.delete(m.id);
      await fs.rm(m.dir, { recursive: true, force: true });
    },
    async inspect(m) { return { dir: m.dir, sealed: false, running: fsSync.existsSync(m.dir) }; },
  };
}
