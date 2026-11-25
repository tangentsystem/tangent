// Docker driver: one container per machine, driven through the docker CLI.
// Each machine container: not privileged, all capabilities dropped, no-new-privileges,
// read only root file system, runs as uid 1000, CPU / memory / pids limits, the work
// dir and /tmp are size capped tmpfs mounts (the disk limit), no host network
// namespace. Without an egress proxy it has no network at all (--network none).
// With an egress proxy it joins the network namespace of a small sidecar container
// that itself has only loopback; the sidecar forwards 127.0.0.1:1080 over a unix
// socket to the node, which pipes it to the proxy. Nothing else is reachable.
// The agent's headless browser (Chromium) runs INSIDE the machine container (images
// listed in `browserImages`), started with `docker exec` as the machine user, so it
// shares the machine's limits, namespaces, network route and lifetime. See browser().
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SIZES, machinePath } from './common.js';
import { createEgressBridge } from './egress-bridge.js';

const WORK = '/work';
const TMP = '/tmp';
const FORWARDER = fileURLToPath(new URL('./egress-forwarder.mjs', import.meta.url));
const BROWSER_EXEC = fileURLToPath(new URL('./browser-exec.sh', import.meta.url));
export const BROWSER_IMAGE_DIR = fileURLToPath(new URL('../image/', import.meta.url));

// Built locally from src/compute/image/Dockerfile (base pinned by digest, Chromium
// pinned by package version); driver.pull() builds it when it is missing.
export const BROWSER_IMAGE = 'tangent-machine-browser:158';
// Object key order matters: the first image present is the default for a rent.
export const DEFAULT_IMAGES = Object.freeze({ browser: BROWSER_IMAGE, alpine: 'alpine:3.20', node: 'node:22-alpine', python: 'python:3.12-alpine' });
// image name -> Chromium binary inside that image
export const DEFAULT_BROWSER_IMAGES = Object.freeze({ browser: '/usr/lib/chromium/chromium' });
// in-container port of the egress forwarder (sidecar network namespace)
const EGRESS_PORT = 1080;

export function createDockerDriver({
  dockerBin = 'docker',
  dockerHost = process.env.DOCKER_HOST,
  images = DEFAULT_IMAGES,
  sizes = DEFAULT_SIZES,
  sidecarImage = 'node:22-alpine',
  namePrefix = 'tangent-',
  user = '1000:1000',
  tmpMb = 64,
  runtime = null,          // e.g. 'runsc' (gVisor) when the host has it
  runDir = path.join(os.tmpdir(), 'tangent-compute-egress'),
  browserImages = DEFAULT_BROWSER_IMAGES,
  // where playwright keeps its empty bookkeeping dirs for each machine's browser
  // (the browser itself never sees or writes them; removed with the machine)
  browserRunDir = path.join(os.tmpdir(), 'tangent-compute-browser'),
  // options for building the browser image: { network, buildArgs: {}, secrets: { id: file } }
  browserBuild = {},
  log = () => {},
} = {}) {
  const env = { ...process.env };
  if (dockerHost) env.DOCKER_HOST = dockerHost;
  const [uid, gid] = user.split(':');

  function docker(args, { input, maxBytes = 8 * 1024 * 1024, timeoutMs = 120_000 } = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn(dockerBin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const out = []; const err = []; let n = 0; let over = false;
      const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
      p.stdout.on('data', (b) => { n += b.length; if (n > maxBytes) { over = true; p.kill('SIGKILL'); } else out.push(b); });
      p.stderr.on('data', (b) => err.push(b));
      p.on('error', (e) => { clearTimeout(t); reject(e); });
      p.on('close', (code) => { clearTimeout(t); resolve({ code, over, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }); });
      p.stdin.on('error', () => {});
      if (input) p.stdin.end(input); else p.stdin.end();
    });
  }
  async function must(args, opts) {
    const r = await docker(args, opts);
    if (r.code !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr.trim().slice(0, 300)}`);
    return r;
  }

  const hostPathOk = (p) => machinePath(p, { workDir: WORK, roots: [WORK, TMP] });
  try { fs.accessSync(BROWSER_EXEC, fs.constants.X_OK); } catch { try { fs.chmodSync(BROWSER_EXEC, 0o755); } catch {} }
  const browserRef = images.browser || null;

  // build the browser image from src/compute/image (instead of pulling it)
  async function buildBrowserImage(ref) {
    const args = ['build', '-t', ref, '--label', 'tangent.compute.image=browser'];
    if (browserBuild.network) args.push('--network', browserBuild.network);
    for (const [k, v] of Object.entries(browserBuild.buildArgs || {})) args.push('--build-arg', `${k}=${v}`);
    for (const [id, file] of Object.entries(browserBuild.secrets || {})) args.push('--secret', `id=${id},src=${file}`);
    args.push(BROWSER_IMAGE_DIR);
    log('compute.docker.build', { image: ref });
    return must(args, { timeoutMs: 1_800_000 });
  }
  // kill every process inside the container that carries this marker in its environment
  const killMarked = (name, varName, mark) => docker(['exec', '-u', user, name, 'sh', '-c',
    `for d in /proc/[0-9]*; do grep -qs '${varName}=${mark}' "$d/environ" && kill -9 "\${d#/proc/}" 2>/dev/null; done; true`], { timeoutMs: 10_000 }).catch(() => {});

  return {
    name: 'docker',
    sealed: true,
    description: 'one container per machine: no privileges, capabilities dropped, read only root, resource limits, no host network',
    sizes,
    imageNames: Object.keys(images),
    async check() {
      try {
        const r = await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 8000 });
        return r.code === 0 ? { ok: true, sealed: true, version: r.stdout.toString().trim() } : { ok: false, reason: r.stderr.trim().slice(0, 200) };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
    // names of images that are present locally
    async images() {
      const out = [];
      for (const [name, ref] of Object.entries(images)) {
        const r = await docker(['image', 'inspect', '--format', '{{.Id}}', ref], { timeoutMs: 10_000 }).catch(() => ({ code: 1 }));
        if (r.code === 0) out.push(name);
      }
      return out;
    },
    browserImage: browserRef,
    browserImages: Object.keys(browserImages).filter((k) => images[k]),
    // the browser image is built locally from src/compute/image; anything else is pulled
    async pull(name) {
      const ref = images[name] || name;
      if (ref === browserRef) return buildBrowserImage(ref);
      return must(['pull', ref], { timeoutMs: 600_000 });
    },
    // remove containers left over from an earlier run of this node
    async cleanup() {
      const r = await docker(['ps', '-aq', '--filter', `label=tangent.compute=${namePrefix}`]);
      const ids = r.stdout.toString().split(/\s+/).filter(Boolean);
      if (ids.length) await docker(['rm', '-f', ...ids]);
      // browser bookkeeping dirs of machines from an earlier run of this node (all empty)
      await fs.promises.rm(path.join(browserRunDir, namePrefix), { recursive: true, force: true }).catch(() => {});
      return ids.length;
    },
    async create({ id, image, size, egress }) {
      const spec = sizes[size];
      if (!spec) throw new Error('unknown size');
      const ref = images[image];
      if (!ref) throw Object.assign(new Error('unknown image'), { status: 400 });
      const name = namePrefix + id;
      const m = { id, name, image, sidecar: null, bridge: null, spec, paused: false, execs: new Set(), egress: !!egress, browserDir: null };
      const labels = ['--label', `tangent.compute=${namePrefix}`, '--label', `tangent.compute.machine=${id}`];
      const harden = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--ipc', 'private', '--log-driver', 'none', '--ulimit', 'core=0'];
      if (runtime) harden.push('--runtime', runtime);
      let net = ['--network', 'none'];
      const proxyEnv = [];
      try {
        if (egress) {
          m.bridge = await createEgressBridge({ dir: path.join(runDir, id), socksHost: egress.socksHost, socksPort: egress.socksPort });
          m.sidecar = name + '-net';
          await must(['run', '-d', '--name', m.sidecar, '--hostname', 'machine', ...labels, ...harden, '--network', 'none', '--user', user,
            '--memory', '64m', '--memory-swap', '64m', '--pids-limit', '32', '--cpus', '0.25',
            '-v', `${m.bridge.dir}:/egress:ro`, '-v', `${FORWARDER}:/fwd.mjs:ro`, sidecarImage, 'node', '/fwd.mjs']);
          net = ['--network', `container:${m.sidecar}`];
          for (const k of ['ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) proxyEnv.push('-e', `${k}=socks5h://127.0.0.1:${EGRESS_PORT}`);
        }
        await must(['run', '-d', '--name', name, ...labels, ...harden, ...net, ...(m.sidecar ? [] : ['--hostname', 'machine']),
          '--user', user, '--cpus', String(spec.cpus), '--memory', `${spec.memoryMb}m`, '--memory-swap', `${spec.memoryMb}m`,
          '--pids-limit', String(spec.pids), '--ulimit', 'nofile=1024:1024',
          '--tmpfs', `${WORK}:rw,exec,size=${spec.diskMb}m,uid=${uid},gid=${gid},mode=0700`,
          '--tmpfs', `${TMP}:rw,exec,size=${tmpMb}m,mode=1777`,
          '-w', WORK, '-e', `HOME=${WORK}`, ...proxyEnv, '--stop-timeout', '1', '--entrypoint', '',
          ref, 'sh', '-c', 'trap "exit 0" TERM; while :; do sleep 3600 & wait; done']);
      } catch (e) {
        await docker(['rm', '-f', name, ...(m.sidecar ? [m.sidecar] : [])]).catch(() => {});
        if (m.bridge) await m.bridge.close().catch(() => {});
        throw e;
      }
      log('compute.docker.create', { id, image, size });
      return m;
    },
    exec(m, { cmd, stdin, timeoutMs, onStdout, onStderr }) {
      if (m.paused) throw Object.assign(new Error('machine is paused'), { status: 402 });
      const started = Date.now();
      const mark = randomBytes(8).toString('hex');
      const args = ['exec', ...(stdin ? ['-i'] : []), '-u', user, '-w', WORK, '-e', `TANGENT_EXEC=${mark}`, m.name, 'sh', '-c', cmd];
      const p = spawn(dockerBin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      m.execs.add(p);
      let timedOut = false;
      // killing the docker client does not stop the process inside the container,
      // so every process carrying this exec's marker is killed inside the container
      const killInside = () => killMarked(m.name, 'TANGENT_EXEC', mark);
      const kill = () => { killInside().finally(() => setTimeout(() => p.kill('SIGKILL'), 500)); };
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      p.stdout.on('data', (b) => onStdout && onStdout(b));
      p.stderr.on('data', (b) => onStderr && onStderr(b));
      p.stdin.on('error', () => {});
      if (stdin) p.stdin.end(stdin); else p.stdin.end();
      const done = new Promise((resolve) => {
        p.on('error', (e) => onStderr && onStderr(Buffer.from(e.message + '\n')));
        p.on('close', (code, signal) => {
          clearTimeout(timer); m.execs.delete(p);
          resolve({ exitCode: timedOut ? null : code, signal: timedOut ? 'SIGKILL' : (signal || null), timedOut, durationMs: Date.now() - started });
        });
      });
      return { done, kill };
    },
    async writeFile(m, p, data) {
      const abs = hostPathOk(p);
      const r = await docker(['exec', '-i', '-u', user, m.name, 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', abs], { input: data });
      if (r.code !== 0) {
        const nospace = /No space left/i.test(r.stderr);
        throw Object.assign(new Error(nospace ? 'machine disk is full' : `write failed: ${r.stderr.trim().slice(0, 200)}`), { status: nospace ? 507 : 400 });
      }
    },
    async readFile(m, p, maxBytes) {
      const abs = hostPathOk(p);
      const r = await docker(['exec', '-u', user, m.name, 'sh', '-c',
        '[ -f "$1" ] || exit 44; s=$(stat -c %s "$1"); [ "$s" -le "$2" ] || exit 45; cat "$1"', 'sh', abs, String(maxBytes)], { maxBytes: maxBytes + 1 });
      if (r.code === 44) throw Object.assign(new Error('no such file'), { status: 404 });
      if (r.code === 45 || r.over) throw Object.assign(new Error('file too large to read'), { status: 413 });
      if (r.code !== 0) throw Object.assign(new Error(`read failed: ${r.stderr.trim().slice(0, 200)}`), { status: 400 });
      return r.stdout;
    },
    async pause(m) { await must(['pause', m.name]); m.paused = true; },
    async resume(m) { await must(['unpause', m.name]); m.paused = false; },
    async destroy(m) {
      for (const p of m.execs) p.kill('SIGKILL');
      await docker(['rm', '-f', m.name, ...(m.sidecar ? [m.sidecar] : [])]).catch(() => {});
      if (m.bridge) await m.bridge.close().catch(() => {});
      if (m.browserDir) {
        await fs.promises.rm(m.browserDir, { recursive: true, force: true }).catch(() => {});
        await fs.promises.rmdir(path.dirname(m.browserDir)).catch(() => {}); // only when no other machine uses it
      }
    },
    // How the browser pool starts this machine's Chromium: inside the container, never
    // on the host. Returns a launch spec for playwright-core (see browser.js).
    async browser(m) {
      const chromium = browserImages[m.image];
      if (!chromium) throw Object.assign(new Error(`the ${m.image} image has no browser; rent the ${Object.keys(browserImages).join(' or ')} image for browser tools`), { status: 409 });
      if (m.paused) throw Object.assign(new Error('machine is paused'), { status: 402 });
      const mark = randomBytes(8).toString('hex');
      m.browserDir = path.join(browserRunDir, namePrefix, m.id);
      await fs.promises.mkdir(m.browserDir, { recursive: true, mode: 0o700 });
      const args = [
        '--disable-gpu', '--disable-crash-reporter', '--disk-cache-size=16777216',
        // never resolve names locally: with egress the SOCKS proxy resolves them,
        // without egress there is nothing to reach anyway
        '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1',
      ];
      // Chromium bypasses the proxy only for loopback (the machine's own loopback)
      if (m.egress) args.push(`--proxy-server=socks5://127.0.0.1:${EGRESS_PORT}`);
      return {
        sealed: true,
        runsIn: 'machine container',
        executablePath: BROWSER_EXEC,
        env: { ...env, TANGENT_DOCKER: dockerBin, TANGENT_CONTAINER: m.name, TANGENT_USER: user, TANGENT_CHROMIUM: chromium, TANGENT_PROFILE: `${TMP}/.browser-${mark}`, TANGENT_MARK: mark },
        args,
        hostDir: m.browserDir,
        mark,
        // stop anything left of this browser inside the container
        kill: () => killMarked(m.name, 'TANGENT_BROWSER', mark),
      };
    },
    async inspect(m) {
      const r = await must(['inspect', m.name]);
      const [c] = JSON.parse(r.stdout.toString());
      const h = c.HostConfig;
      return {
        status: c.State.Status, privileged: h.Privileged, capDrop: h.CapDrop, readOnlyRoot: h.ReadonlyRootfs,
        networkMode: h.NetworkMode, memory: h.Memory, nanoCpus: h.NanoCpus, pidsLimit: h.PidsLimit, user: c.Config.User,
        securityOpt: h.SecurityOpt, tmpfs: h.Tmpfs,
      };
    },
  };
}
