// publishOnion against a REAL Tor control port. Skipped unless LIVE_TOR_CONTROL=host:port is set
// (optionally LIVE_TOR_PASSWORD for HashedControlPassword auth; without it the cookie file Tor
// names in PROTOCOLINFO is read, so it must be readable at that path from this process).
//
// Tor answers ADD_ONION with the service id and its key even before it has bootstrapped into the
// network, so this proves the control protocol, the auth paths and key reuse. It does not prove the
// onion is reachable through the Tor network (that needs Tor to reach its relays).
//
//   docker run -d --network host -v /tmp/torcookie:/tc --entrypoint tor <a tor image> \
//     --ControlPort 127.0.0.1:19051 --CookieAuthentication 1 --CookieAuthFile /tc/control_auth_cookie \
//     --SocksPort 0 --DataDirectory /tmp/tordata
//   ln -sfn /tmp/torcookie /tc      # the cookie path Tor reports must exist on this side too
//   LIVE_TOR_CONTROL=127.0.0.1:19051 node --test "test/live/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { publishOnion, serviceIdFromKey } from '../../src/relay/onion.js';
import { torProbe } from '../../src/selftest/world.js';
import { STATUS } from '../../src/selftest/report.js';

const CTRL = (process.env.LIVE_TOR_CONTROL || '').trim();
const [host, portText] = CTRL.split(':');
const port = Number(portText);
const password = process.env.LIVE_TOR_PASSWORD;

async function control(lines) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host);
    let buf = '';
    s.on('data', (d) => { buf += d; });
    s.on('error', reject);
    s.on('connect', () => { s.write(lines.join('\r\n') + '\r\nQUIT\r\n'); });
    s.on('close', () => resolve(buf));
  });
}

test('live Tor: publishOnion gets a real v3 onion from the control port, and the saved key gives the same onion again', { skip: CTRL ? false : 'LIVE_TOR_CONTROL is not set', timeout: 60_000 }, async (t) => {
  const torControl = { host, port, ...(password ? { password } : {}) };
  const first = await publishOnion({ torControl, localPort: 18080, virtualPort: 443 });
  assert.ok(first, 'publishOnion returned null');
  assert.match(first.onion, /^[a-z2-7]{56}\.onion$/);
  assert.match(first.privateKey, /^ED25519-V3:[A-Za-z0-9+/=]{80,}$/);
  assert.equal(serviceIdFromKey(first.privateKey) + '.onion', first.onion, 'our derivation matches the address Tor gave');
  // a node restart: the same Tor still holds the detached service, the saved key publishes again
  const again = await publishOnion({ torControl, localPort: 18081, virtualPort: 443, privateKey: first.privateKey });
  assert.equal(again.onion, first.onion, 'the saved key publishes the same address');
  assert.equal(again.privateKey, undefined, 'a known key is not handed back again');
  // Tor itself lists both services as ours
  const auth = password ? `AUTHENTICATE "${password}"` : null;
  const reply = auth ? await control([auth, 'GETINFO onions/detached']) : null;
  if (reply) assert.match(reply, new RegExp(first.onion.replace('.onion', '')));
  const probe = await torProbe({ host, port });
  assert.equal(probe.status, STATUS.PASS, probe.reason);
  t.diagnostic(`onion ${first.onion}; probe: ${probe.detail}`);
  // a wrong password is refused, and publishOnion answers null instead of throwing
  if (password) assert.equal(await publishOnion({ torControl: { host, port, password: password + 'x' }, localPort: 18082 }), null);
});
