// Test loader: inside src/relay/crypto.js?forced-shim, node:crypto resolves to a copy of the app's
// crypto shim that pretends chacha20-poly1305 is missing, as it is in Electron.
export async function resolve(specifier, context, next) {
  if ((specifier === 'node:crypto' || specifier === 'crypto') && context.parentURL && context.parentURL.includes('/src/relay/crypto.js?forced-shim')) {
    return { url: new URL('./forced-shim.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
