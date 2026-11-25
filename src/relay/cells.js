// Wire format for circuits. Every packet on a link is exactly CELL_SIZE bytes so an
// observer (or a relay) cannot tell payload sizes apart.
//
// link cell   = circId u32 | cmd u8 | payload (PAYLOAD bytes)
// RELAY cell  = tag stack (MAX_HOPS * 16) | onion body (BODY bytes)
// onion body plaintext at the hop it is meant for =
//   recognized (8, secret per hop and direction) | rcmd u8 | streamId u16 | len u16 | data | zero pad
import { randomBytes } from 'node:crypto';

export const CELL_SIZE = 1024;
export const HEADER = 5;
export const PAYLOAD = CELL_SIZE - HEADER;   // 1019
export const MAX_HOPS = 5;
export const TAG = 16;
export const STACK = MAX_HOPS * TAG;          // 80
export const BODY = PAYLOAD - STACK;          // 939
export const RECOG = 8;
export const MSG_HEADER = RECOG + 5;          // 13
export const MAX_DATA = BODY - MSG_HEADER;    // 926

// link commands
export const CMD = Object.freeze({ PADDING: 0, CREATE: 1, CREATED: 2, RELAY: 3, DESTROY: 4 });

// relay (inside the onion) commands
export const R = Object.freeze({
  EXTEND: 1, EXTENDED: 2, BEGIN: 3, CONNECTED: 4, DATA: 5, END: 6, SENDME: 7,
  VOUCHER: 8, BILL: 9, VOUCHER_RESULT: 10, TRUNCATED: 11,
});

// flow control (cells). Only DATA cells count against windows.
export const CIRC_WINDOW = 512;
export const CIRC_INC = 64;
export const STREAM_WINDOW = 256;
export const STREAM_INC = 32;

export function linkCell(circId, cmd, payload) {
  const b = Buffer.alloc(CELL_SIZE);
  b.writeUInt32BE(circId >>> 0, 0);
  b[4] = cmd;
  if (payload) {
    if (payload.length > PAYLOAD) throw new Error('cell: payload too large');
    Buffer.from(payload.buffer, payload.byteOffset, payload.length).copy(b, HEADER);
  }
  return b;
}

export function destroyCell(circId, reason = 0) {
  return linkCell(circId, CMD.DESTROY, Buffer.from([reason & 0xff]));
}

export const DESTROY_REASON = Object.freeze({ NONE: 0, PROTOCOL: 1, INTERNAL: 2, RESOURCE: 3, CLOSED: 4, HOP_LOST: 5, SHUTDOWN: 6 });

// Turns a TCP byte stream into whole cells. Cells handed to onCell are views into the
// incoming chunk; copy them if you keep them past the callback.
export function cellReader(onCell) {
  let rest = null;
  return (chunk) => {
    let buf = rest ? Buffer.concat([rest, chunk]) : chunk;
    let off = 0;
    while (buf.length - off >= CELL_SIZE) {
      onCell(buf.subarray(off, off + CELL_SIZE));
      off += CELL_SIZE;
    }
    rest = off === buf.length ? null : Buffer.from(buf.subarray(off));
  };
}

export function packMsg(recog, rcmd, streamId, data) {
  const d = data ? Buffer.from(data) : Buffer.alloc(0);
  if (d.length > MAX_DATA) throw new Error('cell: data too large');
  const b = Buffer.alloc(BODY);
  recog.copy(b, 0);
  b[RECOG] = rcmd;
  b.writeUInt16BE(streamId & 0xffff, RECOG + 1);
  b.writeUInt16BE(d.length, RECOG + 3);
  d.copy(b, MSG_HEADER);
  return b;
}

export function unpackMsg(b) {
  const len = b.readUInt16BE(RECOG + 3);
  if (len > MAX_DATA) return null;
  return { rcmd: b[RECOG], streamId: b.readUInt16BE(RECOG + 1), data: b.subarray(MSG_HEADER, MSG_HEADER + len) };
}

export function randomStack() { return randomBytes(STACK); }

export function jsonData(obj) { return Buffer.from(JSON.stringify(obj)); }
export function parseJson(buf) { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } }
