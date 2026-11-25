// Blind credit token issuer: RFC 9474 RSABSSA-SHA384-PSS-Randomized (@cloudflare/blindrsa-ts).
//
// One RSA key per denomination per period ("epoch"). A key of epoch e issues during [e*P, (e+1)*P) and redeems
// until (e+2)*P, so the keys of two neighbouring epochs overlap for a full period and a token is always good for
// at least one period after it was issued. Keys are created by the service on first need, saved INSERT ONLY
// through store.keys.insert (which also writes the backup copy), and read back from the store, so two instances
// starting together both end up using whichever insert won. A saved key is never replaced.
//
// The blind signature itself is the raw RSA private operation (RSASP1, RFC 9474 section 4.3). Node's webcrypto has
// no RSA-RAW, so instead of the library's slow pure-JS fallback it is done with OpenSSL through
// crypto.privateDecrypt(RSA_NO_PADDING), followed by the RFC's check that s^e mod n gives the input back.
// Clients and verification use the library (src/pay/client.js), and the tests check both paths agree.
import crypto from 'node:crypto';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { fail, sha256Hex, b64u, unb64u } from './util.js';
import { TOKEN_PREFIX } from './messages.js';

export const SUITE_NAME = 'RSABSSA-SHA384-PSS-Randomized';
export const suite = () => RSABSSA.SHA384.PSS.Randomized();
const IMPORT_ALG = { name: 'RSA-PSS', hash: 'SHA-384' };
const DAY = 86400000;

export function epochBounds(epoch, periodMs) {
  return { issueFrom: epoch * periodMs, issueUntil: (epoch + 1) * periodMs, redeemUntil: (epoch + 2) * periodMs };
}

const labelOf = (denom, epoch) => `blind:${denom}:${epoch}`;

export function createIssuer({ store, denominations, periodMs = 30 * DAY, bits = 2048, log = () => {}, now = Date.now }) {
  if (!store || !store.keys) throw new Error('issuer: store with keys is required');
  const denoms = denominations.map((d) => BigInt(d));
  const S = suite();
  const byId = new Map(); // keyId -> loaded key
  const byLabel = new Map(); // label -> loaded key
  const creating = new Map(); // label -> promise

  async function load(row) {
    if (byLabel.has(row.label)) return byLabel.get(row.label);
    const spki = Buffer.from(row.publicKey, 'base64url');
    const keyId = sha256Hex(spki);
    if (row.meta && row.meta.keyId && row.meta.keyId !== keyId) throw new Error(`issuer: saved key "${row.label}" does not match its id; refusing to use or replace it`);
    const nodePriv = crypto.createPrivateKey({ key: Buffer.from(row.secret, 'base64'), format: 'der', type: 'pkcs8' });
    const nodePub = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    if (crypto.createPublicKey(nodePriv).export({ format: 'der', type: 'spki' }).equals(spki) === false) {
      throw new Error(`issuer: saved key "${row.label}" private and public halves differ; refusing to use or replace it`);
    }
    const jwk = nodePub.export({ format: 'jwk' });
    const n = BigInt('0x' + Buffer.from(jwk.n, 'base64url').toString('hex'));
    const modulusBytes = Buffer.from(jwk.n, 'base64url').length;
    const webPub = await crypto.subtle.importKey('spki', spki, IMPORT_ALG, true, ['verify']);
    const { denomination, epoch } = row.meta;
    const k = {
      label: row.label,
      keyId,
      denomination: BigInt(denomination),
      epoch,
      ...epochBounds(epoch, periodMs),
      spki: row.publicKey,
      n,
      modulusBytes,
      nodePriv,
      nodePub,
      webPub,
    };
    byLabel.set(row.label, k);
    byId.set(keyId, k);
    return k;
  }

  async function ensure(denom, epoch) {
    const label = labelOf(denom, epoch);
    if (byLabel.has(label)) return byLabel.get(label);
    if (creating.has(label)) return creating.get(label);
    const p = (async () => {
      let row = await store.keys.get(label);
      if (!row) {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits, publicExponent: 65537 });
        const spki = publicKey.export({ format: 'der', type: 'spki' });
        const keyId = sha256Hex(spki);
        let insertErr = null;
        try {
          const r = await store.keys.insert({
            label,
            kind: 'blind-rsa',
            publicKey: b64u(spki),
            secret: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
            meta: { keyId, denomination: denom.toString(), epoch, suite: SUITE_NAME, bits, periodMs },
          });
          if (r.inserted) log('pay.issuer.key_created', { denomination: denom.toString(), epoch, keyId });
        } catch (err) {
          insertErr = err; // another instance won the insert; read the winner below
        }
        row = await store.keys.get(label);
        if (!row) throw new Error(`issuer: could not save key "${label}": ${insertErr ? insertErr.message : 'missing after insert'}`);
      }
      return load(row);
    })();
    creating.set(label, p);
    try {
      return await p;
    } finally {
      creating.delete(label);
    }
  }

  function denomOk(denom) {
    const d = BigInt(denom);
    if (!denoms.includes(d)) fail('BAD_DENOMINATION', 'unknown denomination');
    return d;
  }

  const epochAt = (t) => Math.floor(t / periodMs);

  async function currentKey(denom) {
    return ensure(denomOk(denom), epochAt(now()));
  }

  async function byKeyId(keyId) {
    if (byId.has(keyId)) return byId.get(keyId);
    for (const row of await store.keys.list('blind:')) {
      if (row.meta && row.meta.keyId === keyId) return load(row);
    }
    return null;
  }

  // Public keys a client may use now: per denomination, the key that issues now plus older keys that still redeem.
  async function publicKeys() {
    const t = now();
    for (const d of denoms) await ensure(d, epochAt(t));
    const out = [];
    for (const row of await store.keys.list('blind:')) {
      const k = await load(row);
      if (k.redeemUntil <= t || k.issueFrom > t) continue;
      if (!denoms.includes(k.denomination)) continue;
      out.push(publicView(k, t));
    }
    out.sort((a, b) => (BigInt(a.denomination) === BigInt(b.denomination) ? a.epoch - b.epoch : BigInt(a.denomination) < BigInt(b.denomination) ? -1 : 1));
    return out;
  }

  function publicView(k, t = now()) {
    return {
      keyId: k.keyId,
      denomination: k.denomination.toString(),
      suite: SUITE_NAME,
      spki: k.spki,
      epoch: k.epoch,
      issues: k.issueFrom <= t && t < k.issueUntil,
      issueUntil: new Date(k.issueUntil).toISOString(),
      redeemUntil: new Date(k.redeemUntil).toISOString(),
    };
  }

  // Checks every blinded message first, then signs them all. -> Uint8Array[]
  function blindSign(k, blindedList) {
    const inputs = blindedList.map((b) => {
      const bytes = unb64u(b, 'BAD_BLINDED');
      if (bytes.length !== k.modulusBytes) fail('BAD_BLINDED', 'blinded message has the wrong length for this key');
      const m = BigInt('0x' + Buffer.from(bytes).toString('hex'));
      if (m <= 1n || m >= k.n - 1n) fail('BAD_BLINDED', 'blinded message out of range');
      return Buffer.from(bytes);
    });
    return inputs.map((m) => {
      const s = crypto.privateDecrypt({ key: k.nodePriv, padding: crypto.constants.RSA_NO_PADDING }, m);
      const back = crypto.publicEncrypt({ key: k.nodePub, padding: crypto.constants.RSA_NO_PADDING }, s);
      if (!back.equals(m)) throw new Error('issuer: signature self check failed'); // RFC 9474 4.3 step 3
      return new Uint8Array(s);
    });
  }

  // token = { keyId, msg, sig } (base64url). -> { key, msgBytes, spentId }. Throws PayError when not valid now.
  async function verifyToken(token) {
    if (!token || typeof token !== 'object') fail('BAD_TOKEN', 'token required');
    const { keyId } = token;
    if (typeof keyId !== 'string' || !/^[0-9a-f]{64}$/.test(keyId)) fail('BAD_TOKEN', 'bad key id');
    const k = await byKeyId(keyId);
    if (!k) fail('UNKNOWN_KEY', 'token key is not known');
    const t = now();
    if (t >= k.redeemUntil) fail('KEY_EXPIRED', 'token key no longer redeems');
    if (t < k.issueFrom) fail('UNKNOWN_KEY', 'token key is not active');
    const msg = unb64u(token.msg, 'BAD_TOKEN');
    const sig = unb64u(token.sig, 'BAD_TOKEN');
    if (sig.length !== k.modulusBytes) fail('BAD_TOKEN', 'signature length');
    // prepared message = 32 random bytes || "tangent:credit:v1:<keyId>:<64 hex serial>"
    const inner = Buffer.from(msg.subarray(32)).toString('utf8');
    const expectPrefix = TOKEN_PREFIX + keyId + ':';
    if (msg.length !== 32 + expectPrefix.length + 64 || !inner.startsWith(expectPrefix) || !/^[0-9a-f]{64}$/.test(inner.slice(expectPrefix.length))) {
      fail('BAD_TOKEN', 'token message format');
    }
    let ok = false;
    try {
      ok = await S.verify(k.webPub, sig, msg);
    } catch {
      ok = false;
    }
    if (!ok) fail('BAD_TOKEN', 'token signature does not verify');
    return { key: k, msgBytes: msg, spentId: sha256Hex(msg) };
  }

  return { currentKey, publicKeys, publicView, blindSign, verifyToken, byKeyId, denominations: denoms, periodMs };
}
