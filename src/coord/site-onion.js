// The site's own .onion address.
//
// The service makes one onion key by itself, the first time it boots on a database: it tries
// random ed25519 seeds until the address starts with ONION_PREFIX, then saves the seed under the
// key rules of src/keys.js (backup first, insert only, never replaced). Every later boot reads
// that same key, so the address never changes. Nothing is read from the environment.
//
// Tor runs as a child process of the service. It only makes outgoing connections, so it needs no
// open port: it carries http://<address>.onion to this service's own http port on 127.0.0.1.
// The service works the same without Tor: when the tor program is missing or will not start,
// this module logs it and the site simply has no onion address.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { ensureKey } from '../keys.js';
import { b58, unb58 } from '../core/index.js';

export const ONION_LABEL = 'site-onion';
export const ONION_PREFIX = 'tan';
const KIND = 'onion-ed25519';
const SECRET_HEADER = '== ed25519v1-secret: type0 ==';
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// v3 address of a 32 byte ed25519 public key: base32(pubkey || checksum[0..2] || 0x03) + ".onion",
// checksum = SHA3-256(".onion checksum" || pubkey || 0x03).
export function onionAddress(publicKey) {
  const pub = Buffer.from(publicKey);
  if (pub.length !== 32) throw new Error('onion: public key must be 32 bytes');
  const version = Buffer.from([3]);
  const check = Buffer.from(sha3_256(Buffer.concat([Buffer.from('.onion checksum'), pub, version]))).subarray(0, 2);
  return base32(Buffer.concat([pub, check, version])) + '.onion';
}

export function onionAddressFromSeed(seed) {
  return onionAddress(ed25519.getPublicKey(Uint8Array.from(seed)));
}

// The file Tor reads as <HiddenServiceDir>/hs_ed25519_secret_key: a 32 byte header, then the
// expanded secret key (SHA-512 of the seed with the usual ed25519 clamping). 96 bytes.
export function hsSecretKeyFile(seed) {
  const s = Buffer.from(seed);
  if (s.length !== 32) throw new Error('onion: seed must be 32 bytes');
  const h = createHash('sha512').update(s).digest();
  h[0] &= 248; h[31] &= 63; h[31] |= 64;
  const head = Buffer.alloc(32);
  head.write(SECRET_HEADER, 'ascii');
  return Buffer.concat([head, h]);
}

function randomCandidate() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  return { seed: Buffer.from(seed), address: onionAddress(pub) };
}

// Tries random keys until one starts with `prefix`. Works in small batches so the service keeps
// answering while it searches. -> { seed, address, tries }
export async function grindOnionKey({ prefix = ONION_PREFIX, batch = 500, maxTries = 50_000_000 } = {}) {
  if (!/^[a-z2-7]{0,6}$/.test(prefix)) throw new Error('onion: prefix must be up to 6 characters of a-z and 2-7');
  let tries = 0;
  while (tries < maxTries) {
    for (let i = 0; i < batch; i++) {
      tries++;
      const c = randomCandidate();
      if (c.address.startsWith(prefix)) return { ...c, tries };
    }
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('onion: no key found');
}

export function checkOnionRow(row) {
  let seed;
  try { seed = unb58(row.secret); } catch { seed = null; }
  if (!seed || seed.length !== 32) return false;
  return onionAddressFromSeed(seed) === row.publicKey;
}

// The saved site onion key, made on first use. -> { address, seed (Buffer), created }
export async function ensureSiteOnionKey(store, { prefix = ONION_PREFIX } = {}) {
  const saved = await store.collection('keys').get(ONION_LABEL);
  let candidate = null;
  if (!saved) {
    const found = await grindOnionKey({ prefix });
    candidate = { kind: KIND, publicKey: found.address, secret: b58(found.seed) };
  }
  const k = await ensureKey(store, ONION_LABEL, { generate: () => candidate, check: checkOnionRow });
  return { address: k.publicKey, seed: Buffer.from(unb58(k.secret)), created: k.created };
}

// Puts the key where Tor reads it. A key file that already holds another key is left alone.
export function installHsKey(hsDir, seed) {
  fs.mkdirSync(hsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(hsDir, 0o700);
  const file = path.join(hsDir, 'hs_ed25519_secret_key');
  const want = hsSecretKeyFile(seed);
  if (fs.existsSync(file)) return fs.readFileSync(file).equals(want);
  fs.writeFileSync(file, want, { flag: 'wx', mode: 0o600 });
  return true;
}

export function torrc({ dataDir, hsDir, port }) {
  return [
    `DataDirectory ${dataDir}`,
    'SocksPort 0',
    `HiddenServiceDir ${hsDir}`,
    `HiddenServicePort 80 127.0.0.1:${port}`,
    'Log notice stdout',
  ].join('\n') + '\n';
}

// Starts Tor for the site. Never throws. -> { address(): string|null (once Tor is up), known(): string|null, stop() }
export async function startSiteOnion({ store, port, log, torBin = 'tor', dir = path.join(os.tmpdir(), 'tangent-site-onion'), prefix = ONION_PREFIX, spawnFn = spawn, print = (line) => process.stdout.write(line + '\n') } = {}) {
  const state = { address: null, ready: false, child: null, timer: null, stopped: false, delay: 2000 };
  const handle = {
    address: () => (state.ready ? state.address : null),
    known: () => state.address,
    stop: async () => {
      state.stopped = true;
      state.ready = false;
      if (state.timer) clearTimeout(state.timer);
      if (state.child) { try { state.child.kill('SIGTERM'); } catch { /* already gone */ } }
    },
  };
  const info = (event, data) => { if (log) log.info(event, data); };
  const warn = (event, data) => { if (log) log.warn(event, data); };

  let rcFile;
  try {
    const key = await ensureSiteOnionKey(store, { prefix });
    state.address = key.address;
    const dataDir = path.join(dir, 'data');
    const hsDir = path.join(dir, 'hs');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(dataDir, 0o700);
    if (!installHsKey(hsDir, key.seed)) { warn('site_onion.other_key_on_disk', { dir: hsDir }); return handle; }
    rcFile = path.join(dir, 'torrc');
    fs.writeFileSync(rcFile, torrc({ dataDir, hsDir, port }), { mode: 0o600 });
    info('site_onion.key', { address: key.address, created: key.created });
  } catch (err) {
    warn('site_onion.setup_failed', { reason: String(err && err.message).slice(0, 200) });
    return handle;
  }

  const run = () => {
    if (state.stopped) return;
    const started = Date.now();
    let child;
    try { child = spawnFn(torBin, ['-f', rcFile], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) {
      warn('site_onion.spawn_failed', { reason: String(err && err.message).slice(0, 200) });
      return;
    }
    state.child = child;
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (/\[err\]/.test(line)) warn('site_onion.tor', { line: line.slice(0, 200) });
        if (/Bootstrapped 100%/.test(line) && !state.ready) {
          state.ready = true;
          info('site_onion.ready', { address: state.address });
          print(`SITE ONION  http://${state.address}`);
        }
      }
    };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    child.on('error', (err) => {
      if (err && err.code === 'ENOENT') { state.stopped = true; warn('site_onion.no_tor', { reason: 'the tor program is not installed here' }); return; }
      warn('site_onion.tor_error', { reason: String(err && err.message).slice(0, 200) });
    });
    child.on('exit', (code, signal) => {
      state.ready = false;
      state.child = null;
      if (state.stopped) return;
      if (Date.now() - started > 120_000) state.delay = 2000;
      warn('site_onion.tor_exited', { code, signal, restartInMs: state.delay });
      state.timer = setTimeout(run, state.delay);
      if (state.timer.unref) state.timer.unref();
      state.delay = Math.min(state.delay * 2, 60_000);
    });
  };
  run();
  process.once('exit', () => { if (state.child) { try { state.child.kill('SIGKILL'); } catch { /* already gone */ } } });
  return handle;
}
