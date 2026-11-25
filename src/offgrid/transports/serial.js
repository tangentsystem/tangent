// Serial transport for radio modems (LoRa boards and similar). Interface and framing only:
// frames are COBS encoded and delimited by 0x00 on the byte stream. NOT TESTED WITH REAL RADIO
// HARDWARE; tests drive it with an in memory port pair.
//
// `port` is injected so there is no native serial dependency here. It must provide:
//   write(bytes)              send raw bytes
//   onData(cb) or on('data', cb)  deliver received bytes (Buffer or Uint8Array chunks)
//   close()?                  optional
// For example a `serialport` SerialPort instance satisfies this (write / on('data') / close).
// A radio is a shared medium, so send(bytes, peer) ignores `peer` and transmits to everyone in range.
import { cobsEncode, cobsDecode } from '../codec.js';

const MAX_BUFFER = 1024;

export function createSerialTransport({ port, name = 'serial', peerId = 'serial:radio', log = () => {} }) {
  if (!port || typeof port.write !== 'function') throw new Error('serial: port with write() required');
  let onFrame = null, running = false, buf = [];
  function onBytes(chunk) {
    if (!running) return;
    for (const b of chunk) {
      if (b === 0) {
        if (buf.length) {
          const dec = cobsDecode(Uint8Array.from(buf));
          buf = [];
          if (dec && dec.length) { try { onFrame?.(dec, { id: peerId }); } catch (e) { log('serial: handler ' + e.message); } }
        }
      } else {
        buf.push(b);
        if (buf.length > MAX_BUFFER) buf = []; // line noise, resync on next delimiter
      }
    }
  }
  return {
    name,
    start(cb) {
      onFrame = cb; running = true;
      if (typeof port.onData === 'function') port.onData(onBytes);
      else if (typeof port.on === 'function') port.on('data', onBytes);
      else throw new Error('serial: port needs onData(cb) or on("data", cb)');
    },
    send(bytes) {
      if (!running) return;
      const enc = cobsEncode(bytes);
      const out = new Uint8Array(enc.length + 2);
      out[0] = 0; out.set(enc, 1); out[out.length - 1] = 0; // leading delimiter flushes noise
      port.write(out);
    },
    stop() { running = false; port.close?.(); },
  };
}

// In memory port pair for tests and local experiments: bytes written to one end come out of the
// other, optionally split into small chunks to mimic a UART.
export function createPortPair({ chunk = 7 } = {}) {
  const mk = () => ({ listeners: [], peer: null });
  const a = mk(), b = mk();
  a.peer = b; b.peer = a;
  const end = (me) => ({
    write(bytes) {
      const data = Uint8Array.from(bytes);
      for (let i = 0; i < data.length; i += chunk) {
        const c = data.subarray(i, i + chunk);
        setImmediate(() => me.peer.listeners.forEach((l) => l(c)));
      }
    },
    onData(cb) { me.listeners.push(cb); },
    close() { me.listeners = []; },
  });
  return [end(a), end(b)];
}
