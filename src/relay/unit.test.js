import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, createKxKeypair, signDescriptor } from '../core/index.js';
import { serverHandshake, clientHandshakeStart, clientHandshakeFinish, wrapForward, peelForward, addBackward, originBackward, unwrapBackward } from './crypto.js';
import { packMsg, unpackMsg, BODY, PAYLOAD, R, cellReader, CELL_SIZE, linkCell, CMD } from './cells.js';
import { isPrivateAddress, resolveTarget } from './addr.js';
import { selectPath, usableDescriptors } from './client.js';

function node(roles = ['relay']) {
  const identity = createIdentity(), kx = createKxKeypair();
  const desc = signDescriptor(identity, { roles, host: '127.0.0.1', port: 9000 + Math.floor(Math.random() * 1000), kx: kx.pub });
  return { identity, kx, desc };
}

function handshake(n) {
  const st = clientHandshakeStart();
  const { reply, keys } = serverHandshake(n, st.X);
  return { client: clientHandshakeFinish(st, n.desc, reply), server: keys };
}

test('handshake agrees on keys and is bound to the descriptor identity', () => {
  const n = node();
  const { client, server } = handshake(n);
  assert.deepEqual(client.kf, server.kf);
  assert.deepEqual(client.kb, server.kb);
  assert.equal(client.session, server.session);
  assert.notDeepEqual(client.kf, client.kb);

  // a hop holding a different identity (but claiming the descriptor) is rejected
  const other = node();
  const st = clientHandshakeStart();
  const { reply } = serverHandshake({ identity: other.identity, kx: n.kx }, st.X);
  assert.throws(() => clientHandshakeFinish(st, n.desc, reply), /identity signature/);

  // right identity but wrong static x25519 key: keys differ, confirmation fails
  const st2 = clientHandshakeStart();
  const { reply: reply2 } = serverHandshake({ identity: n.identity, kx: createKxKeypair() }, st2.X);
  assert.throws(() => clientHandshakeFinish(st2, n.desc, reply2), /identity signature|confirmation/);

  // tampered reply
  const st3 = clientHandshakeStart();
  const { reply: reply3 } = serverHandshake(n, st3.X);
  reply3[0] ^= 1;
  assert.throws(() => clientHandshakeFinish(st3, n.desc, reply3));
});

test('three layer onion: each hop peels one layer, sizes never change, replay and tamper fail', () => {
  const nodes = [node(), node(), node(['relay', 'exit'])];
  const pairs = nodes.map(handshake);
  const client = pairs.map((p) => p.client);
  const servers = pairs.map((p) => p.server);

  const secret = Buffer.from('payload-for-the-exit-only');
  const body = packMsg(client[2].rf, R.DATA, 7, secret);
  const cell = wrapForward(client, 2, body);
  assert.equal(cell.length, PAYLOAD);

  const r0 = peelForward(servers[0], cell);
  assert.ok(r0 && !r0.mine);
  assert.equal(r0.payload.length, PAYLOAD);
  assert.ok(!r0.payload.includes(secret));
  const r1 = peelForward(servers[1], r0.payload);
  assert.ok(r1 && !r1.mine);
  assert.ok(!r1.payload.includes(secret));
  const r2 = peelForward(servers[2], r1.payload);
  assert.ok(r2 && r2.mine);
  const msg = unpackMsg(r2.pt);
  assert.equal(msg.rcmd, R.DATA);
  assert.equal(msg.streamId, 7);
  assert.deepEqual(Buffer.from(msg.data), secret);

  // replay of the same cell at hop 0 fails (nonce counter moved on)
  assert.equal(peelForward(servers[0], cell), null);

  // message for the middle hop is recognized there
  const forMiddle = wrapForward(client, 1, packMsg(client[1].rf, R.VOUCHER, 0, Buffer.from('{}')));
  // (a failed replay does not move the counter; the relay closes the circuit on it anyway)
  const m0 = peelForward(servers[0], forMiddle);
  assert.ok(m0 && !m0.mine);
  const m1 = peelForward(servers[1], m0.payload);
  assert.ok(m1 && m1.mine);
  assert.equal(unpackMsg(m1.pt).rcmd, R.VOUCHER);
  // out of order: an older counter value at hop 1 fails
  assert.equal(peelForward(servers[1], r0.payload), null);

  // backward: exit originates, middle and entry add layers, client peels all three
  const pairs2 = nodes.map(handshake);
  const c2 = pairs2.map((p) => p.client), s2 = pairs2.map((p) => p.server);
  const back = originBackward(s2[2], packMsg(s2[2].rb, R.DATA, 3, Buffer.from('reply')));
  const b1 = addBackward(s2[1], back);
  const b0 = addBackward(s2[0], b1);
  assert.equal(b0.length, PAYLOAD);
  const got = unwrapBackward(c2, b0);
  assert.equal(got.hop, 2);
  assert.equal(unpackMsg(got.pt).data.toString(), 'reply');

  // middle originated backward cell is attributed to hop 1
  const fromMid = addBackward(s2[0], originBackward(s2[1], packMsg(s2[1].rb, R.BILL, 0, Buffer.from('{}'))));
  assert.equal(unwrapBackward(c2, fromMid).hop, 1);

  // tampered backward cell fails
  const t = addBackward(s2[0], originBackward(s2[1], packMsg(s2[1].rb, R.BILL, 0, Buffer.from('{}'))));
  t[t.length - 1] ^= 1;
  assert.equal(unwrapBackward(c2, t), null);
});

test('cell reader splits streams into fixed size cells', () => {
  const cells = [];
  const read = cellReader((c) => cells.push(Buffer.from(c)));
  const a = linkCell(1, CMD.RELAY, Buffer.alloc(10, 1)), b = linkCell(2, CMD.DESTROY, null);
  const all = Buffer.concat([a, b]);
  read(all.subarray(0, 100)); read(all.subarray(100, 1500)); read(all.subarray(1500));
  assert.equal(cells.length, 2);
  assert.ok(cells.every((c) => c.length === CELL_SIZE));
  assert.equal(cells[1].readUInt32BE(0), 2);
  assert.equal(BODY + 80 + 5, CELL_SIZE);
});

test('private address policy', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fe80::1', 'fd00:ec2::254', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254',
    '64:ff9b::10.0.0.1', '224.0.0.1', '255.255.255.255', 'ff02::1', 'not-an-ip']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
  await assert.rejects(resolveTarget('127.0.0.1'), (e) => e.code === 'policy');
  await assert.rejects(resolveTarget('metadata.test', { resolve: async () => ['169.254.169.254'] }), (e) => e.code === 'policy');
  assert.equal(await resolveTarget('mixed.test', { resolve: async () => ['10.0.0.1', '8.8.4.4'] }), '8.8.4.4');
  assert.equal(await resolveTarget('127.0.0.1', { allowPrivate: true }), '127.0.0.1');
  await assert.rejects(resolveTarget('nx.test', { resolve: async () => { throw new Error('nx'); } }), (e) => e.code === 'resolve');
});

test('path selection: relay entry, exit last, no repeats, enough nodes required', () => {
  const r1 = node(), r2 = node(), r3 = node(), x1 = node(['exit', 'relay']), x2 = node(['exit']);
  const dir = usableDescriptors([r1.desc, r2.desc, r3.desc, x1.desc, x2.desc]);
  for (let i = 0; i < 200; i++) {
    const p = selectPath(dir, { hops: 3 });
    assert.equal(p.length, 3);
    assert.ok(p[0].roles.includes('relay'));
    assert.ok(p[1].roles.includes('relay'));
    assert.ok(p[2].roles.includes('exit'));
    assert.equal(new Set(p.map((d) => d.id)).size, 3);
  }
  assert.throws(() => selectPath(usableDescriptors([r1.desc, r2.desc]), { hops: 3 }), /no exit/);
  assert.throws(() => selectPath(usableDescriptors([r1.desc, x2.desc]), { hops: 3 }), /not enough/);
  assert.throws(() => selectPath(dir, { hops: 6 }), /hops/);
  assert.throws(() => selectPath(dir, { hops: 3, exclude: new Set([x1.desc.id, x2.desc.id]) }), /no exit/);
  // forged or stale descriptors are dropped
  const forged = { ...r1.desc, port: 1 };
  const stale = signDescriptor(r2.identity, { roles: ['relay'], host: '127.0.0.1', port: 9, kx: r2.kx.pub, ts: Date.now() - 7 * 3600_000 });
  assert.equal(usableDescriptors([forged, stale]).length, 0);
});
