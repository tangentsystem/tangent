// Shared API test suite run against each driver (imported by *.test.js files).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction, Keypair } from '@solana/web3.js';
import { createIdentity } from '../core/identity.js';
import { signVoucher } from '../core/voucher.js';
import { createComputeClient, createAutopay } from './client.js';
import { startNode, fakePayer } from './test-helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function runApiSuite(label, makeDriver, { image } = {}) {
  test(`${label}: machine API`, { timeout: 240_000 }, async (t) => {
    const node = await startNode({ driver: makeDriver(), inbox: { perIp: { limit: 1000, windowMs: 60_000 }, perMachine: { limit: 5, windowMs: 60_000 }, maxMessageBytes: 1024 } });
    const client = createComputeClient({ baseUrl: node.url });
    const wallet = fakePayer();
    const payer = wallet.identityFor(node.identity.id);
    const pays = [];
    t.after(async () => { for (const p of pays) p.stop(); await node.close(); });

    const info = await client.info();
    assert.equal(info.node, node.identity.id);
    assert.ok(info.images.length > 0);

    const a = await client.rent({ payer: payer.id, image, size: 'small' });
    const b = await client.rent({ payer: payer.id, image, size: 'small' });
    // keep both machines paid for the length of the suite (slow hosts can exceed the 10 s credit)
    for (const m of [a, b]) { const p = createAutopay({ machine: m, nodeId: node.identity.id, payer: wallet, intervalMs: 1000 }); p.start(); pays.push(p); }

    await t.test('rent returns id, token, price', () => {
      assert.match(a.machineId, /^m_[0-9a-f]{24}$/);
      assert.ok(a.token.length >= 40);
      assert.equal(a.rent.priceLamportsPerSecond, '1000');
      assert.equal(a.rent.creditLimitLamports, '10000');
      assert.equal(a.rent.sealed, info.sealed);
      assert.equal(a.rent.wallet.explorer, `https://solscan.io/account/${a.rent.wallet.address}`);
    });

    await t.test('exec stdout, stderr, exit code', async () => {
      const r = await a.exec('echo hello; echo oops 1>&2; exit 3');
      assert.equal(r.stdout, 'hello\n');
      assert.equal(r.stderr, 'oops\n');
      assert.equal(r.exitCode, 3);
      assert.equal(r.timedOut, false);
      const s = await a.exec('cat', { stdin: 'from stdin' });
      assert.equal(s.stdout, 'from stdin');
    });

    await t.test('exec timeout kills the command', async () => {
      const t0 = Date.now();
      const r = await a.exec('echo start; sleep 30; echo never', { timeoutMs: 1000 });
      assert.equal(r.timedOut, true);
      assert.equal(r.stdout, 'start\n');
      assert.ok(Date.now() - t0 < 10_000);
      const ps = await a.exec('for d in /proc/[0-9]*; do cat $d/cmdline 2>/dev/null | tr "\\0" " "; echo; done | grep "sleep 30" | grep -v grep || true');
      assert.equal(ps.stdout.trim(), '', 'sleep must be gone');
    });

    await t.test('large output: buffered is capped, streamed is complete', async () => {
      const r = await a.exec('head -c 3000000 /dev/zero | tr "\\0" x');
      assert.equal(r.stdout.length, 1024 * 1024);
      assert.equal(r.stdoutTruncated, true);
      let n = 0; let errN = 0;
      const s = await a.execStream('head -c 5000000 /dev/zero | tr "\\0" y; echo done 1>&2', { onStdout: (buf) => { n += buf.length; }, onStderr: (buf) => { errN += buf.length; } });
      assert.equal(n, 5_000_000);
      assert.equal(errN, 5);
      assert.equal(s.exitCode, 0);
    });

    await t.test('file round trip, text and binary', async () => {
      const bin = Buffer.concat([Buffer.from([...Array(256).keys()]), randomBytes(1024 * 1024)]);
      await a.writeFile('data/blob.bin', bin);
      const back = await a.readFile('data/blob.bin');
      assert.ok(back.equals(bin));
      await a.writeFile('/work/hello.txt', 'hi there');
      assert.equal((await a.readFile('hello.txt')).toString(), 'hi there');
      const r = await a.exec('wc -c < data/blob.bin');
      assert.equal(r.stdout.trim(), String(bin.length));
      await assert.rejects(a.readFile('../../etc/passwd'), (e) => e.status === 400);
      await assert.rejects(a.readFile('missing.txt'), (e) => e.status === 404);
    });

    await t.test('token auth: wrong token refused, one machine cannot touch another', async () => {
      const wrong = client.machine(a.machineId, 'not-the-token');
      await assert.rejects(wrong.exec('id'), (e) => e.status === 401);
      const crossed = client.machine(b.machineId, a.token);
      await assert.rejects(crossed.exec('id'), (e) => e.status === 401);
      await assert.rejects(crossed.readFile('hello.txt'), (e) => e.status === 401);
      await assert.rejects(crossed.signMessage('x'), (e) => e.status === 401);
      await assert.rejects(crossed.inbox(), (e) => e.status === 401);
      await assert.rejects(crossed.stop(), (e) => e.status === 401);
      const r = await fetch(new URL(`machines/${a.machineId}/exec`, node.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"cmd":"id"}' });
      assert.equal(r.status, 401);
      // b cannot see a's files
      await assert.rejects(b.readFile('hello.txt'), (e) => e.status === 404);
    });

    await t.test('wallet: address, message signature, transaction signatures', async () => {
      const w = await a.wallet();
      assert.equal(w.address, a.rent.wallet.address);
      const msg = 'prove it ' + Date.now();
      const s = await a.signMessage(msg);
      assert.ok(ed25519.verify(bs58.decode(s.signature), new TextEncoder().encode(msg), bs58.decode(w.address)));
      const owner = new PublicKey(w.address);
      const blockhash = bs58.encode(randomBytes(32));
      const legacy = new Transaction({ feePayer: owner, recentBlockhash: blockhash }).add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports: 5000 }));
      const signed = await a.signTransaction(legacy.serialize({ requireAllSignatures: false }).toString('base64'));
      const tx = Transaction.from(Buffer.from(signed.transaction, 'base64'));
      assert.ok(tx.verifySignatures());
      assert.equal(bs58.encode(tx.signature), signed.signature);
      const msgV0 = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message();
      const v0 = new VersionedTransaction(msgV0);
      const sv = await a.signTransaction(Buffer.from(v0.serialize()).toString('base64'));
      const back = VersionedTransaction.deserialize(Buffer.from(sv.transaction, 'base64'));
      assert.ok(ed25519.verify(back.signatures[0], back.message.serialize(), owner.toBytes()));
      // a transaction this wallet does not sign for is refused
      const other = Keypair.generate().publicKey;
      const foreign = new Transaction({ feePayer: other, recentBlockhash: blockhash }).add(SystemProgram.transfer({ fromPubkey: other, toPubkey: other, lamports: 1 }));
      await assert.rejects(a.signTransaction(foreign.serialize({ requireAllSignatures: false }).toString('base64')), (e) => e.status === 400);
      // b has a different wallet
      assert.notEqual((await b.wallet()).address, w.address);
      // the secret key appears nowhere in API output
      const st = JSON.stringify(await a.status());
      assert.ok(!/secret/i.test(st));
    });

    await t.test('inbox: public post, authenticated read, size and rate limits', async () => {
      assert.equal((await client.postInbox(b.machineId, 'hello machine')).accepted, true);
      await client.postInbox(b.machineId, { from: 'agent-7', subject: 'task', body: 'do the thing' });
      const r = await b.inbox();
      assert.equal(r.messages.length, 2);
      assert.equal(r.messages[0].body, 'hello machine');
      assert.equal(r.messages[1].from, 'agent-7');
      const later = await b.inbox({ after: r.cursor });
      assert.equal(later.messages.length, 0);
      await assert.rejects(client.postInbox(b.machineId, 'x'.repeat(2000)), (e) => e.status === 413);
      await assert.rejects(client.postInbox('m_000000000000000000000000', 'x'), (e) => e.status === 404);
      const unauth = await fetch(new URL(`machines/${b.machineId}/inbox`, node.url));
      assert.equal(unauth.status, 401);
      // per machine limit is 5 per window; 2 accepted so far (the 413 was refused before counting? no: counted after parse)
      let limited = false;
      for (let i = 0; i < 10; i++) {
        try { await client.postInbox(b.machineId, 'm' + i); } catch (e) { if (e.status === 429) { limited = true; break; } throw e; }
      }
      assert.ok(limited, 'rate limit must trigger');
    });

    await t.test('stop destroys the machine', async () => {
      const fin = await b.stop();
      assert.equal(fin.state, 'stopped');
      await assert.rejects(b.exec('id'), (e) => e.status === 410);
      await assert.rejects(client.postInbox(b.machineId, 'x'), (e) => e.status === 404);
    });
  });

  test(`${label}: billing pauses, vouchers resume, grace destroys`, { timeout: 120_000 }, async (t) => {
    let refuse = false;
    const accepted = [];
    const node = await startNode({
      driver: makeDriver(), tickMs: 50, creditLimitSeconds: 1, graceMs: 2500,
      onVoucher: async (v) => { if (refuse) return { ok: false, reason: 'no credit' }; accepted.push(v); return { ok: true }; },
    });
    t.after(() => node.close());
    const client = createComputeClient({ baseUrl: node.url });
    const payer = createIdentity();
    const m = await client.rent({ payer: payer.id, image, size: 'small' });
    await m.exec('echo up');
    const voucher = (cumulative, seq, who = payer) => signVoucher(who, { session: m.machineId, node: node.identity.id, kind: 'compute', cumulative, seq, expires: Date.now() + 60_000 });

    // credit limit = 1 s of price; wait past it with no voucher
    await sleep(1600);
    let st = await m.status();
    assert.equal(st.state, 'paused');
    await assert.rejects(m.exec('echo hi'), (e) => e.status === 402);
    const ins = await node.compute.inspect(m.machineId);
    if (ins.status !== undefined) assert.equal(ins.status, 'paused');

    // forged vouchers are rejected
    const good = voucher(BigInt(st.usage.owedLamports) + 20_000n, 1);
    await assert.rejects(m.sendVoucher({ ...good, cumulative: '999999999' }), (e) => e.status === 400 && e.body.reason === 'signature');
    await assert.rejects(m.sendVoucher(voucher(50_000n, 1, createIdentity())), (e) => e.status === 400);
    await assert.rejects(m.sendVoucher(signVoucher(payer, { session: m.machineId, node: createIdentity().id, kind: 'compute', cumulative: 50_000n, seq: 1, expires: Date.now() + 60_000 })), (e) => e.body.reason === 'wrong node');
    refuse = true;
    await assert.rejects(m.sendVoucher(good), (e) => e.status === 402);
    refuse = false;
    assert.equal((await m.status()).state, 'paused');

    // a real voucher resumes it
    const r = await m.sendVoucher(good);
    assert.equal(r.accepted, true);
    assert.equal(r.state, 'running');
    assert.equal((await m.exec('echo back')).stdout, 'back\n');
    await assert.rejects(m.sendVoucher(good), (e) => e.body.reason === 'stale seq');
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].cumulative, good.cumulative);

    st = await m.status();
    assert.ok(BigInt(st.usage.paidLamports) === BigInt(good.cumulative));
    // billed time stops while paused: about 1 s of running before the pause, not the 1.6 s of wall time
    assert.ok(st.usage.milliseconds >= 1000 && st.usage.milliseconds < 1500, String(st.usage.milliseconds));

    // a second machine with no voucher is destroyed after the grace period
    const m2 = await client.rent({ payer: payer.id, image, size: 'small' });
    await sleep(1300);
    assert.equal((await m2.status()).state, 'paused');
    await sleep(3000);
    await assert.rejects(m2.status(), (e) => e.status === 410 && /grace/.test(e.body.reason));
    assert.equal(node.compute.machines().some((x) => x.machineId === m2.machineId), false);
  });
}
