import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, parseBypass, chromeBypassList, BASE_BYPASS } from '../lib/bypass.js';

test('accepts the forms Chrome understands and normalises them', () => {
  const ok = {
    'example.com': 'example.com',
    'Example.COM.': 'example.com',
    '*.example.com': '*.example.com',
    '.example.com': '*.example.com',
    'example.com:8443': 'example.com:8443',
    'https://www.example.com/some/page?q=1': 'www.example.com',
    'http://example.com:8080/': 'example.com:8080',
    'example.com/path': 'example.com',
    '192.168.1.20': '192.168.1.20',
    '10.0.0.0/8': '10.0.0.0/8',
    '192.168.1.20:3000': '192.168.1.20:3000',
    '::1': '[::1]',
    '[fe80::1]:8080': '[fe80::1]:8080',
    'fd00::/8': 'fd00::/8',
    'xn--bcher-kva.example': 'xn--bcher-kva.example',
  };
  for (const [input, want] of Object.entries(ok)) assert.deepEqual(parseLine(input), { entry: want }, input);
});

test('rejects things that are not sites, with a reason', () => {
  for (const bad of ['exa mple.com', 'localhostonly', 'foo..com', '-bad.com', 'bad-.com', 'ex*ample.com', 'a.*.com',
    '300.1.1.1', '10.0.0.0/40', 'example.com:0', 'example.com:70000', 'ftp://example.com', 'http://', '1.2.3', '[zz::1]']) {
    const r = parseLine(bad);
    assert.ok(r.error, `${bad} should be rejected, got ${JSON.stringify(r)}`);
  }
});

test('blank lines and comments are ignored, duplicates collapse, errors carry line numbers', () => {
  const r = parseBypass('example.com\n\n# my bank\nEXAMPLE.com\nnot a site\nbank.example.org\n');
  assert.deepEqual(r.list, ['example.com', 'bank.example.org']);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 5);
  assert.equal(r.errors[0].text, 'not a site');
});

test('empty text is a valid empty list', () => {
  assert.deepEqual(parseBypass(''), { list: [], errors: [] });
});

test('very long lists are refused', () => {
  const text = Array.from({ length: 501 }, (_, i) => `s${i}.example.com`).join('\n');
  assert.equal(parseBypass(text).errors.length, 1);
});

test('the Chrome list always starts with local entries and widens names to subdomains', () => {
  assert.deepEqual(chromeBypassList([]), ['<local>', '127.0.0.1', 'localhost']);
  const l = chromeBypassList(['example.com', '*.foo.org', '10.0.0.0/8', '192.168.1.2', '[::1]']);
  for (const b of BASE_BYPASS) assert.ok(l.includes(b));
  assert.ok(l.includes('example.com') && l.includes('*.example.com'));
  assert.ok(l.includes('*.foo.org') && !l.includes('*.*.foo.org'));
  assert.ok(l.includes('10.0.0.0/8') && !l.includes('*.10.0.0.0/8'));
  assert.ok(!l.includes('*.192.168.1.2'));
});
