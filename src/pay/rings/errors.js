// Errors thrown by Rings adapters. `permanent: true` means the payment can never succeed as asked
// AND nothing was sent, so the worker may refund. Anything else is treated as transient and retried.
export class RingsError extends Error {
  constructor(code, message, { permanent = false, cause } = {}) {
    super(message || code);
    this.name = 'RingsError';
    this.code = code;
    this.permanent = permanent;
    if (cause !== undefined) this.cause = cause;
  }
}

export const PERMANENT_CODES = Object.freeze(['INVALID_ADDRESS', 'RECIPIENT_NOT_REGISTERED', 'UNSUPPORTED_ASSET', 'INVALID_AMOUNT']);

export function isPermanent(err) {
  return Boolean(err && err.permanent === true);
}
