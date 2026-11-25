// Tangent Systems. The exact bodies clients sign (ed25519 over canonical JSON, src/core identity.signObject). Shared by the
// server (verification) and src/pay/client.js (signing), so the two can never disagree.
// A Solana wallet's signMessage over canonicalBytes(body) produces the same signature.

export function issueBody({ wallet, challenge, denomination, blinded }) {
  return { t: 'tangent.pay.issue', v: 1, wallet: String(wallet), challenge: String(challenge), denomination: String(denomination), blinded: blinded.map(String) };
}

// Signed by the throwaway account identity. Binding the token to the account in the signature means an
// observer who copies the request cannot redirect the credit to another account without its own token.
export function redeemBody({ token, accountId }) {
  return { t: 'tangent.pay.redeem', v: 1, keyId: String(token.keyId), msg: String(token.msg), sig: String(token.sig), accountId: String(accountId) };
}

export function withdrawBody({ wallet, challenge, to, amount, public: isPublic = false }) {
  return { t: 'tangent.pay.withdraw', v: 1, wallet: String(wallet), challenge: String(challenge), to: String(to), amount: String(amount), public: Boolean(isPublic) };
}

// Read only, so a timestamp instead of a one time challenge.
export function balanceBody({ wallet, ts }) {
  return { t: 'tangent.pay.balance', v: 1, wallet: String(wallet), ts: Number(ts) };
}

// The message inside a credit token, before RFC 9474 "prepare" adds its 32 random bytes in front.
export const TOKEN_PREFIX = 'tangent:credit:v1:';
export function tokenInnerMessage(keyId, serialHex) {
  return TOKEN_PREFIX + keyId + ':' + serialHex;
}
