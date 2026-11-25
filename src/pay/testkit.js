// Test helpers for the pay module (not loaded by the service).
import { createIdentity } from '../core/identity.js';
import { createMemoryStore } from './store.js';
import { createSimRings } from './rings/sim.js';
import { createPay } from './index.js';
import { prepareTokens, finalizeTokens, issueRequest, redeemRequest, newAccount, withdrawRequest } from './client.js';

export const DENOMS = ['1000000', '10000000', '100000000', '1000000000'];

export function clock(start = Date.UTC(2026, 0, 1)) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
    return t;
  };
  now.set = (v) => {
    t = v;
  };
  return now;
}

// A fake node registry: nodes.add(identity, payout?)
export function fakeNodes() {
  const m = new Map();
  return {
    add(id, payout) {
      m.set(id, payout === undefined ? id : payout);
    },
    remove(id) {
      m.delete(id);
    },
    isRegistered: async (id) => m.has(id),
    payoutAddress: async (id) => m.get(id) || null,
  };
}

export function makePay({ store = createMemoryStore(), rings = createSimRings({}), nodes = fakeNodes(), now = clock(), config = {}, hooks, logs = [] } = {}) {
  const pay = createPay({ store, rings, nodes, now, hooks, config: { payExposeSim: true, payoutMinLamports: '1000000', withdrawMinLamports: '1000', ...config }, log: (ev, data) => logs.push([ev, data]) });
  return { pay, store, rings, nodes, now, logs };
}

// Puts `lamports` into `wallet`'s balance through a simulated Rings transfer and a deposit sync.
export async function fund(ctx, wallet, lamports) {
  ctx.rings.sim.fund(wallet.id, 'SOL', BigInt(lamports));
  ctx.rings.sim.userSendToVault(wallet.id, 'SOL', BigInt(lamports));
  return ctx.pay.syncDeposits();
}

export async function keyFor(pay, denomination) {
  const keys = await pay.issuerPublicKeys();
  return keys.find((k) => k.denomination === String(denomination) && k.issues);
}

// Full client flow: blind, issue, unblind. -> tokens
export async function buyTokens(pay, wallet, denomination, count = 1) {
  const key = await keyFor(pay, denomination);
  const { pending, blinded } = await prepareTokens(key, count);
  const { challenge } = await pay.challenge(wallet.id);
  const res = await pay.issueBlindTokens(issueRequest(wallet, { challenge, denomination, blinded }));
  return { tokens: await finalizeTokens(key, pending, res.blindSigs), res, key, blinded, pending };
}

export async function redeemInto(pay, token, account = newAccount()) {
  const r = await pay.redeemToken(redeemRequest(token, account));
  return { account, r };
}

export async function withdrawReq(pay, wallet, fields) {
  const { challenge } = await pay.challenge(wallet.id);
  return pay.withdraw(withdrawRequest(wallet, { challenge, ...fields }));
}

export { createIdentity, newAccount };
