import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import express from 'express';
import { createWeb } from './index.js';
import { SITE_URL, PAGES, GUIDES } from './pages.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the site serves the node installer as plain text, and it is the file in the repo', async () => {
  const app = express();
  app.use(createWeb({ token: null }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/install.sh`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/plain/);
    const body = await r.text();
    assert.equal(body, fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8'));
    assert.ok(body.startsWith('#!/usr/bin/env bash'));
  } finally { server.close(); }
});

test('the installer is valid bash and joins the network this site runs', () => {
  const script = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  assert.equal(spawnSync('bash', ['-n', path.join(ROOT, 'install.sh')]).status, 0);
  assert.ok(script.includes(`COORD="\${TANGENT_COORDINATOR:-${SITE_URL}}"`));
  assert.ok(script.includes('https://github.com/tangentsystem/tangent.git'));
});

test('the site shows the same one line everywhere', () => {
  const line = `curl -fsSL ${SITE_URL}/install.sh | sudo bash`;
  assert.equal(PAGES.find((p) => p.path === '/nodes').cmd[5], line);
  const guide = GUIDES.find((g) => g.path === '/docs/run-a-node');
  const code = guide.sections.flatMap((s) => s.blocks).filter((b) => b[0] === 'code').map((b) => b[1]);
  assert.ok(code.includes(line));
});
