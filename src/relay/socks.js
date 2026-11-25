// Minimal SOCKS5 server side: no auth method, CONNECT only, IPv4 / IPv6 / domain targets.
// Domains are passed through untouched so DNS is resolved at the exit, never locally.

export const REP = Object.freeze({ OK: 0, GENERAL: 1, NOT_ALLOWED: 2, NET_UNREACHABLE: 3, HOST_UNREACHABLE: 4, REFUSED: 5, TTL: 6, CMD_UNSUPPORTED: 7, ATYP_UNSUPPORTED: 8 });

export function replyCell(rep) {
  return Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]);
}

function ipv6String(buf) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(i).toString(16));
  return parts.join(':');
}

// Reads the greeting and the request from a socket. Resolves { host, port, rest } or
// rejects (after writing the right error reply). rest = bytes that came after the request.
export function readSocksRequest(sock, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let stage = 0;
    const timer = setTimeout(() => fail(new Error('socks: timeout')), timeoutMs);
    function done() { clearTimeout(timer); sock.removeListener('data', onData); sock.removeListener('error', onErr); sock.removeListener('close', onClose); }
    function fail(err, rep) {
      done();
      if (rep !== undefined && !sock.destroyed) sock.end(replyCell(rep));
      else sock.destroy();
      reject(err);
    }
    function onErr(e) { fail(e); }
    function onClose() { fail(new Error('socks: closed')); }
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 1024) return fail(new Error('socks: oversized'));
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5) return fail(new Error('socks: not version 5'));
        const n = buf[1];
        if (buf.length < 2 + n) return;
        const methods = buf.subarray(2, 2 + n);
        buf = buf.subarray(2 + n);
        if (!methods.includes(0)) { done(); sock.end(Buffer.from([5, 0xff])); return reject(new Error('socks: no acceptable auth')); }
        sock.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        if (buf[0] !== 5) return fail(new Error('socks: bad request'), REP.GENERAL);
        const cmd = buf[1], atyp = buf[3];
        let host, off;
        if (atyp === 1) { if (buf.length < 10) return; host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`; off = 8; }
        else if (atyp === 3) { const l = buf[4]; if (buf.length < 5 + l + 2) return; host = buf.subarray(5, 5 + l).toString('utf8'); off = 5 + l; }
        else if (atyp === 4) { if (buf.length < 22) return; host = ipv6String(buf.subarray(4, 20)); off = 20; }
        else return fail(new Error('socks: bad address type'), REP.ATYP_UNSUPPORTED);
        const port = buf.readUInt16BE(off);
        const rest = Buffer.from(buf.subarray(off + 2));
        if (cmd !== 1) return fail(new Error('socks: only CONNECT'), REP.CMD_UNSUPPORTED);
        done();
        resolve({ host, port, rest });
      }
    }
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.on('close', onClose);
  });
}

export function repForReason(reason = '') {
  if (reason.startsWith('refused')) return REP.NOT_ALLOWED;
  if (reason.startsWith('resolve')) return REP.HOST_UNREACHABLE;
  if (reason.startsWith('connect refused')) return REP.REFUSED;
  if (reason.startsWith('timeout')) return REP.TTL;
  if (reason.startsWith('connect')) return REP.HOST_UNREACHABLE;
  return REP.GENERAL;
}
