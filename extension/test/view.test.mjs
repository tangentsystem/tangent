import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveView, decideProxy, iconOn } from '../lib/view.js';

const ST_ON = { connected: true, connecting: false, socks: { host: '127.0.0.1', port: 47612 }, hops: [{ id: 'AAAAaaaa1111' }, { id: 'BBBBbbbb2222' }, { id: 'CCCCcccc3333' }], usage: { bytesUp: 10, bytesDown: 90 }, since: 1000, needsBalance: false, error: null };
const ST_OFF = { connected: false, connecting: false, socks: null, hops: [], usage: { bytesUp: 0, bytesDown: 0 }, since: null, needsBalance: false, error: null };
const base = { app: 'up', paired: true, pairing: null, pairNote: null, status: ST_OFF, engaged: false, turning: false, control: 'controllable_by_this_extension', note: null, now: 61_000 };
const v = (o) => deriveView({ ...base, ...o });
const d = (o) => decideProxy({ ...base, ...o });

test('views when this browser is not on Tangent', () => {
  assert.equal(v({ app: 'down', paired: false }).name, 'noapp');
  assert.equal(v({ app: 'down' }).name, 'noapp');
  assert.equal(v({ paired: false }).name, 'unpaired');
  assert.equal(v({ paired: false, pairNote: 'denied' }).pairNote, 'denied');
  assert.equal(v({ paired: false, pairing: { id: 'x' } }).name, 'pairing');
  assert.equal(v({}).name, 'off');
  assert.equal(v({ status: ST_ON }).name, 'off', 'app on elsewhere does not mean this browser is on');
  assert.equal(v({ turning: true }).name, 'turning');
  assert.equal(v({ status: { ...ST_OFF, needsBalance: true } }).name, 'balance');
  assert.equal(v({ note: 'timeout' }).note, 'timeout');
});

test('views while engaged', () => {
  const on = v({ engaged: true, status: ST_ON });
  assert.equal(on.name, 'on');
  assert.deepEqual(on.hops, ['AAAAaaaa1111', 'BBBBbbbb2222', 'CCCCcccc3333']);
  assert.equal(on.bytes, 100);
  assert.equal(on.elapsed, 60_000);
  assert.equal(on.port, 47612);
  assert.equal(v({ engaged: true, status: { ...ST_OFF, connecting: true } }).name, 'turning');
  assert.equal(v({ engaged: true, status: { ...ST_ON, needsBalance: true } }).name, 'balance');
});

test('kill switch views: engaged but the path is gone', () => {
  assert.deepEqual([v({ engaged: true, status: ST_OFF }).name, v({ engaged: true, status: ST_OFF }).reason], ['paused', 'dropped']);
  assert.deepEqual([v({ engaged: true, app: 'down', status: null }).name, v({ engaged: true, app: 'down', status: null }).reason], ['paused', 'app']);
  assert.deepEqual([v({ engaged: true, paired: false, status: null }).name, v({ engaged: true, paired: false, status: null }).reason], ['paused', 'unpaired']);
  assert.equal(v({ engaged: true, status: { ...ST_OFF, error: 'No nodes answered.' } }).note, 'No nodes answered.');
});

test('someone else controlling the setting wins over everything', () => {
  assert.deepEqual(v({ control: 'controlled_by_other_extensions', engaged: true, status: ST_ON }).by, 'extension');
  assert.deepEqual(v({ control: 'not_controllable' }).by, 'policy');
  assert.equal(v({ control: 'controlled_by_other_extensions', app: 'down' }).name, 'controlled');
});

test('proxy decisions', () => {
  assert.deepEqual(d({ engaged: true, status: ST_ON }), { action: 'apply', port: 47612 });
  assert.deepEqual(d({ engaged: true, status: { ...ST_ON, socks: { host: '127.0.0.1', port: 50000 } } }), { action: 'apply', port: 50000 });
  // kill switch: never fall back to the open internet on its own
  assert.deepEqual(d({ engaged: true, status: ST_OFF }), { action: 'hold' });
  assert.deepEqual(d({ engaged: true, app: 'down', status: null }), { action: 'hold' });
  assert.deepEqual(d({ engaged: true, paired: false, status: null }), { action: 'hold' });
  assert.deepEqual(d({ engaged: true, status: { ...ST_OFF, connecting: true } }), { action: 'hold' });
  // not engaged: remove only our own leftovers
  assert.deepEqual(d({ control: 'controlled_by_this_extension' }), { action: 'clear' });
  assert.deepEqual(d({}), { action: 'none' });
  assert.deepEqual(d({ status: ST_ON }), { action: 'none' });
  // others in control, or a turn on in progress: hands off
  assert.deepEqual(d({ engaged: true, status: ST_ON, control: 'controlled_by_other_extensions' }), { action: 'none' });
  assert.deepEqual(d({ engaged: true, status: ST_OFF, control: 'not_controllable' }), { action: 'none' });
  assert.deepEqual(d({ turning: true, control: 'controlled_by_this_extension' }), { action: 'none' });
});

test('icon is on only while this browser really goes through Tangent', () => {
  const i = (o) => iconOn({ ...base, ...o });
  assert.equal(i({ engaged: true, status: ST_ON }), true);
  assert.equal(i({ engaged: false, status: ST_ON }), false);
  assert.equal(i({ engaged: true, status: ST_OFF }), false);
  assert.equal(i({ engaged: true, status: { ...ST_ON, needsBalance: true } }), false);
  assert.equal(i({ engaged: true, status: ST_ON, control: 'controlled_by_other_extensions' }), false);
  assert.equal(i({ engaged: true, app: 'down', status: ST_ON }), false);
});
