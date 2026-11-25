// Canonical JSON: keys sorted, no whitespace, BigInt as decimal string.
// Every signature in the network is made over canonical(obj) of the unsigned body.
export function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (value instanceof Uint8Array) throw new Error('canonical: encode bytes as base58/base64 string first');
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  throw new Error('canonical: unsupported type ' + typeof value);
}
export function canonicalBytes(value) {
  return new TextEncoder().encode(canonical(value));
}
