// Release detection: a download is offered only while its file is really published.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReleases, ASSETS, RELEASE_REPO } from './releases.js';

const BASE = `https://github.com/${RELEASE_REPO}/releases`;
const res = (status, location) => ({ status, headers: { get: (k) => (k.toLowerCase() === 'location' ? location || null : null) } });

// world: file name -> tag | '404' | 'error' | 'ratelimit' | 'elsewhere'
function fakeFetch(world, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const name = url.split('/').pop();
    assert.equal(url, `${BASE}/latest/download/${name}`);
    assert.equal(init.method, 'HEAD');
    assert.equal(init.redirect, 'manual');
    const v = world[name];
    if (v === 'error') throw new Error('network down');
    if (v === 'ratelimit') return res(429);
    if (v === 'elsewhere') return res(302, `https://evil.example/${name}`);
    if (!v || v === '404') return res(404);
    return res(302, `${BASE}/download/${v}/${name}`);
  };
}

test('nothing published: nothing offered', async () => {
  const r = createReleases({ fetchFn: fakeFetch({}) });
  assert.deepEqual(r.current(), { windows: null, linux: null, extension: null, version: null, app: false });
  assert.equal(await r.refresh(), true);
  assert.deepEqual(r.current(), { windows: null, linux: null, extension: null, version: null, app: false });
  assert.equal(r.checked(), true);
});

test('published files are offered at their latest address with the version of the release', async () => {
  const world = { [ASSETS.windows]: 'v0.1.0', [ASSETS.linux]: 'v0.1.0', [ASSETS.extension]: 'v0.1.0' };
  const calls = [];
  const r = createReleases({ fetchFn: fakeFetch(world, calls) });
  await r.refresh();
  assert.deepEqual(r.current(), {
    windows: `${BASE}/latest/download/Tangent-Setup.exe`,
    linux: `${BASE}/latest/download/Tangent.AppImage`,
    extension: `${BASE}/latest/download/tangent-chrome-extension.zip`,
    version: '0.1.0',
    app: true,
  });
  assert.equal(calls.length, 3);
});

test('only some files: only those are offered; the extension alone does not make the app available', async () => {
  const world = { [ASSETS.extension]: 'v0.2.0' };
  const r = createReleases({ fetchFn: fakeFetch(world) });
  await r.refresh();
  assert.equal(r.current().app, false);
  assert.ok(r.current().extension);
  world[ASSETS.linux] = 'v0.2.0';
  await r.refresh();
  assert.equal(r.current().app, true);
  assert.equal(r.current().windows, null);
  assert.equal(r.current().version, '0.2.0');
});

test('errors and rate limits change nothing; a plain 404 removes the file', async () => {
  const world = { [ASSETS.windows]: 'v1.2.3', [ASSETS.linux]: 'v1.2.3' };
  const r = createReleases({ fetchFn: fakeFetch(world) });
  assert.equal(await r.refresh(), true);
  world[ASSETS.windows] = 'error';
  world[ASSETS.linux] = 'ratelimit';
  assert.equal(await r.refresh(), false);
  assert.ok(r.current().windows && r.current().linux, 'kept through errors');
  world[ASSETS.windows] = '404';
  world[ASSETS.linux] = 'v1.2.3';
  await r.refresh();
  assert.equal(r.current().windows, null);
  assert.ok(r.current().linux);
});

test('a redirect that does not point at this repo is not trusted', async () => {
  const r = createReleases({ fetchFn: fakeFetch({ [ASSETS.windows]: 'elsewhere' }) });
  assert.equal(await r.refresh(), false);
  assert.equal(r.current().windows, null);
  assert.equal(r.current().app, false);
});

test('a tag that is not a version still offers the file, without a version', async () => {
  const r = createReleases({ fetchFn: fakeFetch({ [ASSETS.linux]: 'nightly' }) });
  await r.refresh();
  assert.ok(r.current().linux);
  assert.equal(r.current().version, null);
});

test('start checks at once, keeps checking, and stop ends it', async () => {
  const world = {};
  const calls = [];
  const r = createReleases({ fetchFn: fakeFetch(world, calls), refreshMs: 20, retryMs: 20 });
  r.start();
  await new Promise((s) => setTimeout(s, 15));
  assert.equal(r.checked(), true);
  world[ASSETS.windows] = 'v0.1.0';
  await new Promise((s) => setTimeout(s, 60));
  assert.equal(r.current().app, true);
  r.stop();
  const n = calls.length;
  await new Promise((s) => setTimeout(s, 60));
  assert.equal(calls.length, n);
});

test('bad repo names are refused', () => {
  assert.throws(() => createReleases({ repo: 'a/b/c' }));
  assert.throws(() => createReleases({ repo: 'https://x/y' }));
});
