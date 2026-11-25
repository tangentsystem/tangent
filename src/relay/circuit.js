// Client end of one circuit: builds it hop by hop (telescoping), wraps and unwraps
// onion layers, multiplexes streams, and pays each hop with vouchers signed by a
// separate throwaway identity per hop.
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomInt } from 'node:crypto';
import { signVoucher } from '../core/index.js';
import { CMD, R, CELL_SIZE, linkCell, destroyCell, DESTROY_REASON, cellReader, packMsg, unpackMsg, jsonData, parseJson, CIRC_WINDOW, MAX_HOPS } from './cells.js';
import { clientHandshakeStart, clientHandshakeFinish, wrapForward, unwrapBackward, HS_TYPE, HS_REPLY_LEN } from './crypto.js';
import { createEdge } from './edge.js';
import { normLog } from './log.js';

const SLACK_CELLS = BigInt(CIRC_WINDOW + 64); // cells that may be in flight when a hop bills us
const VOUCHER_TTL_MS = 60 * 60_000;

export class CircuitError extends Error {
  constructor(message, failedNode = null) { super(message); this.failedNode = failedNode; }
}

let nextCircuitNo = 1;

export class ClientCircuit extends EventEmitter {
  constructor({ path, credit, log, maxStreams = 64 }) {
    super();
    this.no = nextCircuitNo++;
    this.path = path;
    this.credit = credit || null;
    this.log = normLog(log);
    this.hops = [];
    this.sock = null;
    this.circId = randomInt(1, 0xffffffff);
    this.open = false;
    this.closed = false;
    this.closeReason = null;
    this.failedNode = null;
    this.createdAt = Date.now();
    this.nextStreamId = 1;
    this.pending = null; // { resolve, reject } for CREATED / EXTENDED
    this.connecting = new Map(); // streamId -> { resolve, reject, stream }
    this.voucherResults = [];
    this.edge = createEdge({
      sendData: (sid, chunk) => this._sendToHop(this.hops.length - 1, R.DATA, sid, chunk),
      sendControl: (rcmd, sid, data) => this._sendToHop(this.hops.length - 1, rcmd, sid, data),
      canSendData: () => this.open && !this.closed,
      violation: (reason) => this.close('flow control: ' + reason),
      onStreamGone: () => this.emit('streams'),
    }, { maxStreams });
  }

  get exitIndex() { return this.hops.length - 1; }

  async build({ timeoutMs = 15_000 } = {}) {
    if (this.path.length < 1 || this.path.length > MAX_HOPS) throw new CircuitError('bad path length');
    const first = this.path[0];
    await new Promise((resolve, reject) => {
      const sock = net.connect({ host: first.host, port: first.port });
      this.sock = sock;
      sock.setNoDelay(true);
      const t = setTimeout(() => { sock.destroy(); reject(new CircuitError('connect timeout', first.id)); }, timeoutMs);
      sock.once('connect', () => { clearTimeout(t); resolve(); });
      sock.once('error', (e) => { clearTimeout(t); reject(new CircuitError('connect failed: ' + e.code, first.id)); });
    });
    this.sock.on('data', cellReader((cell) => this._onCell(cell)));
    this.sock.on('error', () => {});
    this.sock.on('close', () => this.close('link closed'));

    for (let i = 0; i < this.path.length; i++) {
      const desc = this.path[i];
      const hs = clientHandshakeStart();
      const reply = await this._await(timeoutMs, desc.id, () => {
        if (i === 0) this.sock.write(linkCell(this.circId, CMD.CREATE, Buffer.concat([Buffer.from([HS_TYPE]), hs.X])));
        else this._sendToHop(i - 1, R.EXTEND, 0, jsonData({ host: desc.host, port: desc.port, hs: hs.X.toString('base64') }));
      });
      let keys;
      try { keys = clientHandshakeFinish(hs, desc, reply); } catch (e) {
        this.close('handshake failed');
        throw new CircuitError(e.message, desc.id);
      }
      this.hops.push({
        ...keys, desc, cells: 0n, paid: 0n, seq: 0, payer: null, lastBill: null,
        price: BigInt(desc.prices?.perMbLamports ?? 0),
      });
    }
    this.open = true;
    return this;
  }

  _await(timeoutMs, nodeId, send) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new CircuitError('circuit closed', nodeId));
      const t = setTimeout(() => { this.pending = null; this.close('timeout'); reject(new CircuitError('hop timeout', nodeId)); }, timeoutMs);
      this.pending = {
        resolve: (v) => { clearTimeout(t); this.pending = null; resolve(v); },
        reject: (e) => { clearTimeout(t); this.pending = null; reject(e); },
        nodeId,
      };
      send();
    });
  }

  _sendToHop(t, rcmd, sid, data) {
    if (this.closed || !this.sock) return;
    const body = packMsg(this.hops[t].rf, rcmd, sid, data);
    const payload = wrapForward(this.hops, t, body);
    for (let j = 0; j <= t; j++) this.hops[j].cells++;
    this.sock.write(linkCell(this.circId, CMD.RELAY, payload));
  }

  _onCell(cell) {
    if (this.closed || cell.readUInt32BE(0) !== this.circId) return;
    const cmd = cell[4];
    if (cmd === CMD.CREATED) {
      if (this.pending && this.hops.length === 0) this.pending.resolve(Buffer.from(cell.subarray(5, 5 + HS_REPLY_LEN)));
      return;
    }
    if (cmd === CMD.DESTROY) {
      const reason = cell[5];
      if (this.pending) this.pending.reject(new CircuitError(reason === DESTROY_REASON.RESOURCE ? 'hop refused: busy' : 'circuit destroyed', this.pending.nodeId));
      return this.close('destroyed');
    }
    if (cmd !== CMD.RELAY) return;
    const r = unwrapBackward(this.hops, cell.subarray(5));
    if (!r) return this.close('integrity');
    for (let j = 0; j <= r.hop; j++) this.hops[j].cells++;
    const msg = unpackMsg(r.pt);
    if (!msg) return this.close('protocol');
    this._dispatch(r.hop, msg);
  }

  _dispatch(t, msg) {
    const isExit = this.open && t === this.exitIndex;
    switch (msg.rcmd) {
      case R.EXTENDED: {
        if (!this.pending || t !== this.hops.length - 1) return;
        const res = parseJson(msg.data);
        if (!res || !res.ok) return this.pending.reject(new CircuitError('extend failed: ' + (res?.reason || 'unknown'), this.pending.nodeId));
        return this.pending.resolve(Buffer.from(res.reply, 'base64'));
      }
      case R.BILL: return this._onBill(t, parseJson(msg.data));
      case R.VOUCHER_RESULT: {
        const res = parseJson(msg.data);
        this.voucherResults.push({ hop: t, ...res });
        if (this.voucherResults.length > 100) this.voucherResults.shift();
        this.emit('voucher-result', { hop: t, ...res });
        if (res && !res.ok) {
          this.log.warn('client: voucher rejected', { hop: t, reason: res.reason });
          // let the credit owner know (it may top the account up; see src/node/credit.js)
          const h = this.hops[t];
          if (h && h.desc) { try { this.credit?.short?.(h.desc.id, res.reason); } catch { /* never breaks the circuit */ } }
        }
        return;
      }
      case R.TRUNCATED: {
        const failed = this.path[t + 1];
        this.failedNode = failed ? failed.id : null;
        return this.close('hop lost');
      }
      case R.CONNECTED: {
        if (!isExit) return;
        const c = this.connecting.get(msg.streamId);
        if (c) { this.connecting.delete(msg.streamId); c.resolve(c.stream); }
        return;
      }
      case R.END: {
        if (!isExit) return;
        const c = this.connecting.get(msg.streamId);
        if (c) {
          this.connecting.delete(msg.streamId);
          c.stream.endSent = true;
          c.stream.destroy();
          const e = new CircuitError('stream refused: ' + msg.data.toString('utf8'));
          e.reason = msg.data.toString('utf8');
          return c.reject(e);
        }
        this.edge.handle(msg);
        return;
      }
      case R.DATA: case R.SENDME:
        if (isExit) this.edge.handle(msg);
        return;
      default: return;
    }
  }

  // A hop asks to be paid. Pay what it says, but never more than our own count of the
  // cells that went through it (plus what can be in flight).
  _onBill(t, bill) {
    const h = this.hops[t];
    if (!h || !bill || bill.session !== h.session) return;
    let owed;
    try { owed = BigInt(bill.owed); } catch { return; }
    const est = ((h.cells + SLACK_CELLS) * BigInt(CELL_SIZE) * h.price + 999_999n) / 1_000_000n;
    const amount = owed < est ? owed : est;
    let theirPaid = 0n;
    try { theirPaid = BigInt(bill.paid ?? 0); } catch { /* ignore */ }
    if (amount <= h.paid && theirPaid >= h.paid) return;
    if (!h.payer) {
      const id = this.credit?.identityFor?.(h.desc.id);
      if (!id) return;
      h.payer = id;
    }
    h.seq++;
    if (amount > h.paid) h.paid = amount;
    const v = signVoucher(h.payer, { session: h.session, node: h.desc.id, kind: 'relay', cumulative: h.paid, seq: h.seq, expires: Date.now() + VOUCHER_TTL_MS });
    this._sendToHop(t, R.VOUCHER, 0, jsonData(v));
  }

  // raw voucher send (tests, or a caller that manages payment itself)
  sendVoucher(t, voucher) { this._sendToHop(t, R.VOUCHER, 0, jsonData(voucher)); }

  openStream(host, port, { timeoutMs = 20_000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.open || this.closed) return reject(new CircuitError('circuit not open'));
      let sid = 0;
      for (let i = 0; i < 0xffff; i++) {
        const cand = this.nextStreamId;
        this.nextStreamId = (this.nextStreamId % 0xfffe) + 1;
        if (!this.edge.streams.has(cand)) { sid = cand; break; }
      }
      const stream = sid ? this.edge.add(sid) : null;
      if (!stream) return reject(new CircuitError('too many streams'));
      stream.on('error', () => {});
      const t = setTimeout(() => {
        if (this.connecting.delete(sid)) { stream.destroy(); reject(new CircuitError('stream timeout')); }
      }, timeoutMs);
      this.connecting.set(sid, {
        stream,
        resolve: (s) => { clearTimeout(t); resolve(s); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this._sendToHop(this.exitIndex, R.BEGIN, sid, jsonData({ host, port }));
    });
  }

  streamCount() { return this.edge.streams.size; }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.closeReason = reason;
    if (this.sock && !this.sock.destroyed) {
      this.sock.write(destroyCell(this.circId, DESTROY_REASON.CLOSED));
      this.sock.end();
      setTimeout(() => this.sock.destroy(), 1000).unref?.();
    }
    const err = new CircuitError('circuit closed: ' + reason, this.failedNode);
    if (this.pending) this.pending.reject(err);
    for (const c of this.connecting.values()) c.reject(err);
    this.connecting.clear();
    this.edge.closeAll(err);
    this.emit('close', { reason, failedNode: this.failedNode });
  }

  // [{ node, account }] for the hops that have paid so far
  payers() { return this.hops.filter((h) => h.payer).map((h) => ({ node: h.desc.id, account: h.payer.id })); }

  info() {
    return {
      id: this.no,
      path: this.path.map((d) => d.id),
      open: this.open,
      closed: this.closed,
      closeReason: this.closeReason,
      streams: this.edge.streams.size,
      ageMs: Date.now() - this.createdAt,
      hops: this.hops.map((h) => ({ node: h.desc.id, cells: Number(h.cells), paidLamports: h.paid.toString(), seq: h.seq })),
    };
  }
}

export async function buildCircuit({ path, credit, log, timeoutMs, maxStreams }) {
  const c = new ClientCircuit({ path, credit, log, maxStreams });
  try { await c.build({ timeoutMs }); } catch (e) { c.close('build failed'); throw e; }
  return c;
}
