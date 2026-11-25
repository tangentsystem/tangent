import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortId, formatBytes, formatDuration } from '../lib/format.js';

test('shortId keeps the ends of a node id', () => {
  assert.equal(shortId('7Hk2V9abcdefghijklmnopq9Fa'), '7Hk2…q9Fa');
  assert.equal(shortId('short'), 'short');
  assert.equal(shortId(null), '');
});

test('formatBytes hides zero and scales units', () => {
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(-5), '');
  assert.equal(formatBytes('x'), '');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1500), '1.50 KB');
  assert.equal(formatBytes(12_400_000), '12.4 MB');
  assert.equal(formatBytes(250_000_000), '250 MB');
  assert.equal(formatBytes(3_200_000_000), '3.20 GB');
});

test('formatDuration hides under a second and reads naturally', () => {
  assert.equal(formatDuration(0), '');
  assert.equal(formatDuration(999), '');
  assert.equal(formatDuration(42_000), '42 s');
  assert.equal(formatDuration(14 * 60_000 + 3000), '14 min');
  assert.equal(formatDuration(65 * 60_000), '1 h 5 min');
  assert.equal(formatDuration(2 * 3600_000), '2 h');
  assert.equal(formatDuration(26 * 3600_000), '1 d 2 h');
});
