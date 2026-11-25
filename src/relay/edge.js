// Stream edge logic shared by the client end and the exit end of a circuit.
// Each stream is a Node Duplex: bytes written to it go out as DATA cells, DATA cells
// that arrive are pushed to its readable side. Flow control:
//   circuit window: CIRC_WINDOW data cells in flight per direction, SENDME every CIRC_INC
//   stream window:  STREAM_WINDOW data cells per stream, SENDME every STREAM_INC, and a
//                   stream SENDME is only sent once the reader has consumed the data,
//                   so a slow reader pushes back all the way to the sender.
import { Duplex } from 'node:stream';
import { R, MAX_DATA, CIRC_WINDOW, CIRC_INC, STREAM_WINDOW, STREAM_INC } from './cells.js';

const OUTQ_HIGH = 64;  // cells queued per stream before the writer is told to wait
const OUTQ_LOW = 16;

export class CircuitStream extends Duplex {
  constructor(edge, id) {
    super({ allowHalfOpen: true, readableHighWaterMark: 64 * 1024, writableHighWaterMark: 16 * 1024 });
    this.edge = edge;
    this.id = id;
    this.sendWin = STREAM_WINDOW;
    this.recvWin = STREAM_WINDOW;
    this.delivered = 0;
    this.outq = [];
    this.writeCb = null;
    this.finalCb = null;
    this.endQueued = false;
    this.endSent = false;
    this.remoteEnded = false;
    this.readWanted = true;
    this.endReason = null;
  }

  _write(chunk, _enc, cb) {
    for (let off = 0; off < chunk.length; off += MAX_DATA) this.outq.push(chunk.subarray(off, off + MAX_DATA));
    if (this.outq.length <= OUTQ_HIGH) cb(); else this.writeCb = cb;
    this.edge.pump();
  }

  _final(cb) {
    this.endQueued = true;
    this.finalCb = cb;
    this.edge.pump();
  }

  _read() {
    this.readWanted = true;
    this.flushSendme();
  }

  _destroy(err, cb) {
    this.edge.streamGone(this, err);
    const w = this.writeCb; this.writeCb = null; if (w) w(err || null);
    const f = this.finalCb; this.finalCb = null; if (f) f(err || null);
    cb(err);
  }

  hasCell() { return this.outq.length > 0 && this.sendWin > 0; }

  takeCell() {
    const c = this.outq.shift();
    this.sendWin--;
    if (this.writeCb && this.outq.length <= OUTQ_LOW) { const cb = this.writeCb; this.writeCb = null; cb(); }
    return c;
  }

  wantsEnd() { return this.endQueued && !this.endSent && this.outq.length === 0; }

  queuedCells() { return this.outq.length; }

  // returns false on a protocol violation
  onData(data) {
    if (this.remoteEnded) return true;
    this.recvWin--;
    if (this.recvWin < 0) return false;
    this.delivered++;
    if (!this.push(Buffer.from(data))) this.readWanted = false;
    this.flushSendme();
    return true;
  }

  flushSendme() {
    while (this.readWanted && this.delivered >= STREAM_INC && !this.destroyed) {
      this.delivered -= STREAM_INC;
      this.recvWin += STREAM_INC;
      this.edge.sendControl(R.SENDME, this.id, null);
    }
  }

  onSendme() {
    this.sendWin += STREAM_INC;
    return this.sendWin <= STREAM_WINDOW;
  }

  onEnd(reason) {
    if (this.remoteEnded) return;
    this.remoteEnded = true;
    this.endReason = reason || null;
    this.push(null); // autoDestroy closes the stream once both sides are done
  }
}

// owner = {
//   sendData(streamId, chunk), sendControl(rcmd, streamId, data),
//   canSendData() -> bool, violation(reason), onStreamGone?(stream)
// }
export function createEdge(owner, { maxStreams = 64 } = {}) {
  const streams = new Map();
  let sendWin = CIRC_WINDOW;
  let recvWin = CIRC_WINDOW;
  let delivered = 0;
  let rr = 0;
  let pumping = false;

  const edge = {
    streams,
    get sendWin() { return sendWin; },
    sendControl(rcmd, sid, data) { owner.sendControl(rcmd, sid, data); },

    add(id) {
      if (streams.size >= maxStreams) return null;
      if (streams.has(id)) return null;
      const s = new CircuitStream(edge, id);
      streams.set(id, s);
      return s;
    },

    streamGone(s, err) {
      if (streams.get(s.id) !== s) return;
      streams.delete(s.id);
      if (!s.endSent) {
        s.endSent = true;
        owner.sendControl(R.END, s.id, Buffer.from(err ? 'error' : 'done'));
      }
      owner.onStreamGone?.(s);
    },

    // Called for DATA / END / SENDME addressed to the edge. Returns false on violation.
    handle(msg) {
      const { rcmd, streamId } = msg;
      if (rcmd === R.DATA) {
        recvWin--;
        if (recvWin < 0) { owner.violation('circuit window'); return false; }
        delivered++;
        if (delivered >= CIRC_INC) {
          delivered -= CIRC_INC;
          recvWin += CIRC_INC;
          owner.sendControl(R.SENDME, 0, null);
        }
        const s = streams.get(streamId);
        if (s && !s.onData(msg.data)) { owner.violation('stream window'); return false; }
        return true;
      }
      if (rcmd === R.SENDME) {
        if (streamId === 0) {
          sendWin += CIRC_INC;
          if (sendWin > CIRC_WINDOW) { owner.violation('circuit sendme'); return false; }
        } else {
          const s = streams.get(streamId);
          if (s && !s.onSendme()) { owner.violation('stream sendme'); return false; }
        }
        edge.pump();
        return true;
      }
      if (rcmd === R.END) {
        const s = streams.get(streamId);
        if (s) s.onEnd(msg.data.toString('utf8'));
        return true;
      }
      return true;
    },

    pump() {
      if (pumping) return;
      pumping = true;
      try {
        let progress = true;
        while (progress && sendWin > 0 && owner.canSendData()) {
          progress = false;
          const list = [...streams.values()];
          for (let i = 0; i < list.length && sendWin > 0; i++) {
            const s = list[(rr + i) % list.length];
            if (!s.hasCell()) continue;
            if (!owner.canSendData()) break;
            owner.sendData(s.id, s.takeCell());
            sendWin--;
            progress = true;
          }
          rr++;
        }
        for (const s of streams.values()) {
          if (s.wantsEnd() && owner.canSendData()) {
            s.endSent = true;
            owner.sendControl(R.END, s.id, Buffer.from('done'));
            const f = s.finalCb; s.finalCb = null; if (f) f();
          }
        }
      } finally { pumping = false; }
    },

    queuedCells() { let n = 0; for (const s of streams.values()) n += s.queuedCells(); return n; },

    closeAll(err) {
      for (const s of [...streams.values()]) {
        s.endSent = true; // circuit is gone, nothing to send
        s.destroy(err);
      }
      streams.clear();
    },
  };
  return edge;
}
