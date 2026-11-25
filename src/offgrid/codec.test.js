import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  fragment, decodeFrame, createReassembler, encodeInv, encodeWant, encodeNack, encodeHello,
  cobsEncode, cobsDecode, T, KIND, maxIdsPerFrame, equalBytes,
} from './codec.js';

function shuffle(a, rnd = Math.random) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

test('fragments fit in 200 byte frames and carry header fields', () => {
  const obj = randomBytes(1500);
  const { frames, digest } = fragment(KIND.BUNDLE, obj, 200);
  assert.equal(frames.length, Math.ceil(1500 / 181));
  for (const [i, f] of frames.entries()) {
    assert.ok(f.length <= 200);
    const d = decodeFrame(f);
    assert.equal(d.type, T.DATA); assert.equal(d.index, i); assert.equal(d.total, frames.length); assert.equal(d.len, 1500);
    assert.ok(equalBytes(d.digest, digest));
  }
});

test('frame checksum rejects any flipped bit', () => {
  const { frames } = fragment(KIND.BUNDLE, randomBytes(300));
  for (let i = 0; i < frames[0].length; i++) {
    const bad = Uint8Array.from(frames[0]); bad[i] ^= 0x10;
    assert.equal(decodeFrame(bad), null, 'byte ' + i);
  }
  assert.equal(decodeFrame(new Uint8Array(3)), null);
});

test('reassembly survives loss, duplication and reordering with selective retransmit', () => {
  for (let round = 0; round < 50; round++) {
    const obj = randomBytes(200 + Math.floor(Math.random() * 2500));
    const { frames } = fragment(KIND.BUNDLE, obj);
    let t = 0; const r = createReassembler({ now: () => t });
    let out = null;
    // first pass: drop ~40%, duplicate ~30%, shuffle
    let wave = shuffle(frames.filter(() => Math.random() > 0.4).flatMap((f) => (Math.random() < 0.3 ? [f, f] : [f])));
    for (let pass = 0; pass < 30 && !out; pass++) {
      for (const f of wave) { const res = r.push(decodeFrame(f), 'p'); if (res.status === 'complete') out = res.bytes; }
      if (out) break;
      t += 2000;
      const idle = r.idle(1000);
      if (idle.length === 0) { wave = shuffle([...frames]); continue; } // nothing arrived at all: a fresh WANT resends everything
      const nack = decodeFrame(encodeNack(KIND.BUNDLE, idle[0].st.digest, idle[0].st.total, idle[0].missing));
      assert.deepEqual(nack.missing, idle[0].missing);
      wave = shuffle(nack.missing.map((i) => frames[i]).filter(() => Math.random() > 0.4));
    }
    assert.ok(out && equalBytes(out, obj), 'round ' + round);
  }
});

test('reassembler reports duplicates and rejects mismatched fragments', () => {
  const { frames } = fragment(KIND.RECEIPT, randomBytes(400));
  const r = createReassembler();
  assert.equal(r.push(decodeFrame(frames[0])).status, 'partial');
  assert.equal(r.push(decodeFrame(frames[0])).status, 'duplicate');
  const d = decodeFrame(frames[1]); d.total = 9;
  assert.equal(r.push(d).status, 'mismatch');
});

test('inventory, want, nack and hello frames round trip under 200 bytes', () => {
  const n = maxIdsPerFrame(200);
  const entries = Array.from({ length: n }, (_, i) => ({ kind: 1 + (i % 2), prefix: randomBytes(8) }));
  for (const enc of [encodeInv, encodeWant]) {
    const f = enc(entries); assert.ok(f.length <= 200);
    const d = decodeFrame(f);
    assert.equal(d.entries.length, n);
    d.entries.forEach((e, i) => { assert.equal(e.kind, entries[i].kind); assert.ok(equalBytes(e.prefix, entries[i].prefix)); });
  }
  const nk = decodeFrame(encodeNack(1, randomBytes(8), 13, [0, 5, 12]));
  assert.deepEqual(nk.missing, [0, 5, 12]);
  const id = randomBytes(32);
  const h = decodeFrame(encodeHello(id, 1));
  assert.ok(equalBytes(h.nodeId, id)); assert.equal(h.flags, 1);
});

test('COBS round trips random data and never emits a zero', () => {
  for (let i = 0; i < 500; i++) {
    const len = Math.floor(Math.random() * 600);
    const data = randomBytes(len);
    if (i % 3 === 0) data.fill(0, 0, Math.floor(len / 2));
    const enc = cobsEncode(data);
    assert.ok(!enc.includes(0));
    assert.ok(equalBytes(cobsDecode(enc), data));
  }
  for (const n of [253, 254, 255, 256, 508, 509, 510]) {
    const data = new Uint8Array(n).fill(7);
    assert.ok(equalBytes(cobsDecode(cobsEncode(data)), data), 'run ' + n);
    data[n - 1] = 0;
    assert.ok(equalBytes(cobsDecode(cobsEncode(data)), data), 'run with tail zero ' + n);
  }
});
