// Every setting of the coordinator service, read from the environment once at boot.
//
// The owner sets only MONGO_URI, HELIUS_API_KEY and TOKEN_CA (.env.example).
// Every other value has a default here and is an optional override, listed in
// docs/CONFIG.md. With a completely empty environment the service boots on
// memory storage, answers /api/health and sends nothing on chain.
// A malformed value throws an error that names the variable and never echoes
// the value (so a secret pasted into the wrong variable never reaches the logs).

import bs58 from 'bs58';

export const VERSION = '0.1.0';
export const PRODUCT_NAME = 'Tangent Systems';

export const DEFAULTS = Object.freeze({
  port: 3000,
  mongoDb: 'tangent',
  storePrefix: 'tangent_',
  solanaCluster: 'mainnet',
  trustProxy: 1,
  bodyLimitKb: 256,
  rateLimitPerMin: 300,
  registerLimitPerHour: 30,
  heartbeatLimitPerMin: 120,
  redeemLimitPerMin: 600,
  claimLimitPerMin: 60,
  heartbeatIntervalMs: 60_000,
  livenessMs: 180_000,
  evictAfterMs: 24 * 60 * 60 * 1000,
  sweepIntervalMs: 60_000,
  descriptorMaxAgeMs: 10 * 60 * 1000,
  requestMaxSkewMs: 2 * 60 * 1000,
  directoryMaxNodes: 2000,
  ringsFundingLamports: 50_000_000n,
  provisionPollMs: 60_000,
  payTickMs: 5_000,
  offgridSweepIntervalMs: 10 * 60_000,
  offgridSweepMinLamports: 10_000_000n,
});

function fail(name, why) {
  const err = new Error(`config: ${name} ${why}`);
  err.code = 'BAD_CONFIG';
  err.variable = name;
  throw err;
}

function read(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
}

function int(env, name, fallback, min, max) {
  const raw = read(env, name);
  if (raw === '') return fallback;
  if (!/^[0-9]{1,15}$/.test(raw)) fail(name, 'must be a whole number');
  const n = Number(raw);
  if (n < min || n > max) fail(name, `must be between ${min} and ${max}`);
  return n;
}

function lamports(env, name, fallback) {
  const raw = read(env, name);
  if (raw === '') return fallback;
  if (!/^(0|[1-9][0-9]{0,18})$/.test(raw)) fail(name, 'must be a whole number of lamports');
  return BigInt(raw);
}

function bool(env, name, fallback) {
  const raw = read(env, name);
  if (raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fail(name, 'must be true or false');
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export function isPubkeyText(text) {
  if (typeof text !== 'string' || text.length < 32 || text.length > 44 || !B58.test(text)) return false;
  try { return bs58.decode(text).length === 32; } catch { return false; }
}

function url(env, name) {
  const raw = read(env, name);
  if (raw === '') return '';
  let parsed;
  try { parsed = new URL(raw); } catch { fail(name, 'must be a full http(s) URL'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') fail(name, 'must start with http:// or https://');
  return raw;
}

export function loadConfig(env = process.env) {
  env = env || {};

  const mongoUri = read(env, 'MONGO_URI');
  if (mongoUri !== '' && !/^mongodb(\+srv)?:\/\/\S+$/.test(mongoUri)) fail('MONGO_URI', 'must start with mongodb:// or mongodb+srv://');

  const heliusApiKey = read(env, 'HELIUS_API_KEY');
  if (heliusApiKey !== '' && !/^[A-Za-z0-9_-]{8,128}$/.test(heliusApiKey)) fail('HELIUS_API_KEY', 'does not look like an API key');

  const tokenCa = read(env, 'TOKEN_CA');
  if (tokenCa !== '' && !isPubkeyText(tokenCa)) fail('TOKEN_CA', 'must be a base58 Solana address (32 bytes)');

  const mongoDb = read(env, 'MONGO_DB') || DEFAULTS.mongoDb;
  if (!/^[A-Za-z0-9_-]{1,38}$/.test(mongoDb)) fail('MONGO_DB', 'must be 1 to 38 chars of letters, digits, "_" and "-"');
  const storePrefix = read(env, 'STORE_PREFIX') || DEFAULTS.storePrefix;
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(storePrefix)) fail('STORE_PREFIX', 'must be 1 to 24 chars of a-z, 0-9 and "_", starting with a letter');

  const solanaCluster = read(env, 'SOLANA_CLUSTER') || DEFAULTS.solanaCluster;
  if (solanaCluster !== 'mainnet' && solanaCluster !== 'devnet') fail('SOLANA_CLUSTER', 'must be mainnet or devnet');
  let solanaRpcUrl = url(env, 'SOLANA_RPC_URL');
  const rpcFromHelius = solanaRpcUrl === '' && heliusApiKey !== '';
  if (rpcFromHelius) solanaRpcUrl = `https://${solanaCluster === 'devnet' ? 'devnet' : 'mainnet'}.helius-rpc.com/?api-key=${heliusApiKey}`;

  let trustProxy = DEFAULTS.trustProxy;
  const tp = read(env, 'TRUST_PROXY');
  if (tp !== '') {
    if (/^[0-9]{1,2}$/.test(tp)) trustProxy = Number(tp);
    else if (tp === 'true' || tp === 'false') trustProxy = tp === 'true';
    else fail('TRUST_PROXY', 'must be a number of proxy hops, true or false');
  }

  const heartbeatIntervalMs = int(env, 'HEARTBEAT_INTERVAL_MS', DEFAULTS.heartbeatIntervalMs, 1000, 3_600_000);
  const livenessMs = int(env, 'LIVENESS_MS', Math.max(DEFAULTS.livenessMs, heartbeatIntervalMs * 3), 1000, 86_400_000);
  if (livenessMs < heartbeatIntervalMs) fail('LIVENESS_MS', 'must be at least HEARTBEAT_INTERVAL_MS');
  const evictAfterMs = int(env, 'EVICT_AFTER_MS', DEFAULTS.evictAfterMs, 1000, 365 * 86_400_000);
  if (evictAfterMs < livenessMs) fail('EVICT_AFTER_MS', 'must be at least LIVENESS_MS');

  const config = {
    version: VERSION,
    port: int(env, 'PORT', DEFAULTS.port, 0, 65535),

    mongoUri,
    mongoDb,
    storePrefix,
    storageKind: mongoUri === '' ? 'memory' : 'mongo',
    requireTransactions: bool(env, 'REQUIRE_TRANSACTIONS', false),

    heliusApiKey,
    solanaCluster,
    solanaRpcUrl,
    tokenCa,

    trustProxy,
    bodyLimitKb: int(env, 'BODY_LIMIT_KB', DEFAULTS.bodyLimitKb, 4, 4096),
    rateLimitPerMin: int(env, 'RATE_LIMIT_PER_MIN', DEFAULTS.rateLimitPerMin, 1, 1_000_000),
    registerLimitPerHour: int(env, 'REGISTER_LIMIT_PER_HOUR', DEFAULTS.registerLimitPerHour, 1, 1_000_000),
    heartbeatLimitPerMin: int(env, 'HEARTBEAT_LIMIT_PER_MIN', DEFAULTS.heartbeatLimitPerMin, 1, 1_000_000),
    redeemLimitPerMin: int(env, 'REDEEM_LIMIT_PER_MIN', DEFAULTS.redeemLimitPerMin, 1, 1_000_000),
    claimLimitPerMin: int(env, 'CLAIM_LIMIT_PER_MIN', DEFAULTS.claimLimitPerMin, 1, 1_000_000),

    heartbeatIntervalMs,
    livenessMs,
    evictAfterMs,
    sweepIntervalMs: int(env, 'SWEEP_INTERVAL_MS', DEFAULTS.sweepIntervalMs, 1000, 86_400_000),
    descriptorMaxAgeMs: int(env, 'DESCRIPTOR_MAX_AGE_MS', DEFAULTS.descriptorMaxAgeMs, 1000, 86_400_000),
    requestMaxSkewMs: int(env, 'REQUEST_MAX_SKEW_MS', DEFAULTS.requestMaxSkewMs, 1000, 3_600_000),
    directoryMaxNodes: int(env, 'DIRECTORY_MAX_NODES', DEFAULTS.directoryMaxNodes, 1, 100_000),
    allowPrivateHosts: bool(env, 'ALLOW_PRIVATE_HOSTS', false),

    ringsFundingLamports: lamports(env, 'RINGS_FUNDING_LAMPORTS', DEFAULTS.ringsFundingLamports),
    provisionPollMs: int(env, 'PROVISION_POLL_MS', DEFAULTS.provisionPollMs, 1000, 86_400_000),
    payTickMs: int(env, 'PAY_TICK_MS', DEFAULTS.payTickMs, 500, 3_600_000),

    // Development only: run the pay module on the simulated Rings adapter (no real money,
    // nothing on chain). Used by the end to end test. Ignored when real pay is configured.
    payDevSim: bool(env, 'PAY_DEV_SIM', false),
    // Development only, with PAY_DEV_SIM: also open the deposit and withdraw routes on the simulated
    // adapter (they answer 503 there otherwise), so the end to end test can withdraw through the CLI.
    payDevSimRoutes: bool(env, 'PAY_DEV_SIM_ROUTES', false),
    // Off grid tips move from the tip account into the Rings vault by themselves (always
    // on, src/coord/tip-sweep.js). These only tune how often and from what amount.
    offgridSweepIntervalMs: int(env, 'OFFGRID_SWEEP_INTERVAL_MS', DEFAULTS.offgridSweepIntervalMs, 10_000, 86_400_000),
    offgridSweepMinLamports: lamports(env, 'OFFGRID_SWEEP_MIN_LAMPORTS', DEFAULTS.offgridSweepMinLamports),
  };
  if (config.offgridSweepMinLamports < 1n) fail('OFFGRID_SWEEP_MIN_LAMPORTS', 'must be at least 1');

  // What is switched on, as booleans only (safe to show on /api/health).
  config.flags = Object.freeze({
    mongo: mongoUri !== '',
    helius: heliusApiKey !== '',
    token: tokenCa !== '',
    rpc: solanaRpcUrl !== '',
  });
  return config;
}

// Strings that must never appear in a log line or a response.
export function secretsOf(config = {}) {
  const out = [];
  for (const v of [config.mongoUri, config.heliusApiKey, config.solanaRpcUrl]) if (typeof v === 'string' && v.length >= 6) out.push(v);
  return out.sort((a, b) => b.length - a.length);
}

export function solscan(address, config = {}) {
  const suffix = config.solanaCluster === 'devnet' ? '?cluster=devnet' : '';
  return `https://solscan.io/account/${address}${suffix}`;
}

export function solscanTx(signature, config = {}) {
  const suffix = config.solanaCluster === 'devnet' ? '?cluster=devnet' : '';
  return `https://solscan.io/tx/${signature}${suffix}`;
}
