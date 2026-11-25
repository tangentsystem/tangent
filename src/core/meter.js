// Usage meter shared by relay, offgrid and compute. Each service calls
// meter.add(sessionId, units) as it works; price is lamports per unit block.
// The meter says how much is owed so the service can demand a fresh voucher.
// units: relay = bytes (priced per MB), offgrid = transactions, compute = milliseconds (priced per second).
const UNIT_DIV = Object.freeze({ relay: 1_000_000n, offgrid: 1n, compute: 1000n });

export function createMeter() {
  const sessions = new Map();
  return {
    open(sessionId, { kind, priceLamports, payer }) {
      if (!(kind in UNIT_DIV)) throw new Error('meter: bad kind');
      if (sessions.has(sessionId)) throw new Error('meter: session exists');
      sessions.set(sessionId, { kind, price: BigInt(priceLamports), payer, units: 0n, paid: 0n, openedAt: Date.now() });
    },
    has(sessionId) { return sessions.has(sessionId); },
    add(sessionId, units) {
      const s = sessions.get(sessionId); if (!s) throw new Error('meter: no session');
      s.units += BigInt(units); return this.owed(sessionId);
    },
    // lamports owed so far, rounded up to the next whole lamport
    owed(sessionId) {
      const s = sessions.get(sessionId); if (!s) throw new Error('meter: no session');
      const div = UNIT_DIV[s.kind];
      return (s.units * s.price + div - 1n) / div;
    },
    // record the cumulative amount covered by the newest accepted voucher
    setPaid(sessionId, cumulativeLamports) {
      const s = sessions.get(sessionId); if (!s) throw new Error('meter: no session');
      const c = BigInt(cumulativeLamports); if (c > s.paid) s.paid = c; return s.paid;
    },
    // how far usage is ahead of payment (lamports); service pauses when this exceeds its credit limit
    unpaid(sessionId) {
      const s = sessions.get(sessionId); if (!s) throw new Error('meter: no session');
      const o = this.owed(sessionId); return o > s.paid ? o - s.paid : 0n;
    },
    get(sessionId) { const s = sessions.get(sessionId); return s ? { ...s } : null; },
    close(sessionId) { const s = sessions.get(sessionId); sessions.delete(sessionId); return s ? { ...s, owed: (s.units * s.price + UNIT_DIV[s.kind] - 1n) / UNIT_DIV[s.kind] } : null; },
    list() { return [...sessions.keys()]; },
  };
}
