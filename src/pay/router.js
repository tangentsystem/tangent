// HTTP routes of the pay module, mounted by the coordinator under /api/pay. Every body and param is checked with
// zod; every answer carries Cache-Control: no-store; every address comes with its solscan link.
// Voucher redemption (POST /api/vouchers/redeem) and off grid tip claims are mounted by the coordinator, which
// calls pay.redeemVoucher / pay.creditTip itself.
import express from 'express';
import { z } from 'zod';
import { PayError, isPubkey } from './util.js';

const pubkey = z.string().refine(isPubkey, 'must be a base58 public key');
const lamports = z.string().regex(/^[0-9]{1,31}$/, 'lamports as a decimal string');
const b64 = z.string().regex(/^[A-Za-z0-9_-]+$/, 'base64url').max(4096);
const sig = z.string().min(64).max(100);
const challenge = z.string().min(16).max(64);

const schemas = {
  wallet: z.object({ wallet: pubkey }),
  account: z.object({ id: pubkey }),
  id: z.object({ id: z.string().min(8).max(64) }),
  depositBuild: z.object({ wallet: pubkey, amount: lamports }),
  balance: z.object({ wallet: pubkey, ts: z.number().int(), sig }),
  issue: z.object({ wallet: pubkey, challenge, denomination: lamports, blinded: z.array(b64).min(1).max(100), sig }),
  redeem: z.object({ token: z.object({ keyId: z.string().regex(/^[0-9a-f]{64}$/), msg: b64, sig: b64 }), accountId: pubkey, sig }),
  withdraw: z.object({ wallet: pubkey, challenge, to: pubkey, amount: lamports, public: z.boolean().optional(), sig }),
};

function parse(schema, value) {
  const r = schema.safeParse(value);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new PayError('BAD_REQUEST', (first.path.join('.') || 'body') + ': ' + first.message);
  }
  return r.data;
}

const wrap = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    next(err);
  }
};

export function createPayRouter(pay) {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));
  r.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const needLive = () => {
    if (!pay.live) throw new PayError('RINGS_NOT_CONFIGURED', 'Privacy Rings is not configured on this coordinator', { status: 503 });
  };

  r.get('/deposit/:wallet', wrap(async (req) => {
    needLive();
    return pay.depositAddress(parse(schemas.wallet, req.params).wallet);
  }));

  r.post('/deposit/build', wrap(async (req) => {
    needLive();
    const b = parse(schemas.depositBuild, req.body);
    return pay.depositTx(b.wallet, b.amount);
  }));

  r.post('/challenge', wrap(async (req) => pay.challenge(parse(schemas.wallet, req.body).wallet)));

  r.post('/balance', wrap(async (req) => {
    const b = parse(schemas.balance, req.body);
    return pay.balance(b.wallet, { ts: b.ts, sig: b.sig });
  }));

  r.get('/keys', wrap(async () => ({ keys: await pay.issuerPublicKeys() })));

  r.post('/issue', wrap(async (req) => pay.issueBlindTokens(parse(schemas.issue, req.body))));

  r.post('/redeem', wrap(async (req) => pay.redeemToken(parse(schemas.redeem, req.body))));

  r.get('/account/:id', wrap(async (req, res) => {
    const a = await pay.account(parse(schemas.account, req.params).id);
    if (!a) {
      res.status(404);
      return { error: 'NOT_FOUND', message: 'no such account' };
    }
    return a;
  }));

  r.post('/withdraw', wrap(async (req) => {
    needLive();
    return pay.withdraw(parse(schemas.withdraw, req.body));
  }));

  r.get('/withdraw/:id', wrap(async (req, res) => {
    const w = await pay.withdrawal(parse(schemas.id, req.params).id);
    if (!w) {
      res.status(404);
      return { error: 'NOT_FOUND', message: 'no such withdrawal' };
    }
    return w;
  }));

  // eslint-disable-next-line no-unused-vars
  r.use((err, _req, res, _next) => {
    res.set('Cache-Control', 'no-store');
    if (err instanceof PayError) {
      res.status(err.status || 400).json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
      return;
    }
    if (err && err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'body is not valid JSON' });
      return;
    }
    res.status(500).json({ error: 'INTERNAL', message: 'internal error' });
  });
  return r;
}
