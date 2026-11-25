import test from 'node:test';
import assert from 'node:assert/strict';
import { solString, parseSol } from '../../core/format.js';
import { resolveConfig, DEFAULT_COORDINATOR } from '../../core/config.js';
import { mcpConfigSnippet } from '../../core/mcp.js';

test('lamports to SOL text and back', () => {
  assert.equal(solString('100000000'), '0.1');
  assert.equal(solString('0'), '0');
  assert.equal(solString('1500000000'), '1.5');
  assert.equal(solString('3816692'), '0.003816');
  assert.equal(solString('1'), '0.000000001', 'a tiny amount is never shown as 0');
  assert.equal(solString('nope'), null);
  assert.equal(parseSol('0.1'), 100_000_000n);
  assert.equal(parseSol(' 2 '), 2_000_000_000n);
  assert.equal(parseSol('0.000000001'), 1n);
  for (const bad of ['', '0', '-1', '1e3', '0.0000000001', 'abc', '1,5']) assert.throws(() => parseSol(bad), bad);
});

test('config: the live coordinator by default, overridable for tests', () => {
  const d = resolveConfig({ env: {}, userData: '/tmp/ud' });
  assert.equal(d.coordinator, DEFAULT_COORDINATOR);
  assert.equal(d.coordinator, 'https://tangentsystems.net');
  assert.equal(d.dataDir, '/tmp/ud');
  assert.deepEqual([d.controlPort, d.socksPort, d.mcpPort], [47611, 47612, 47613]);
  const o = resolveConfig({ env: { TANGENT_COORDINATOR: 'http://127.0.0.1:9/', TANGENT_APP_DATA: '/tmp/x', TANGENT_CONTROL_PORT: '0' }, userData: '/tmp/ud' });
  assert.equal(o.coordinator, 'http://127.0.0.1:9');
  assert.equal(o.dataDir, '/tmp/x');
  assert.equal(o.controlPort, 0);
});

test('the MCP snippet is valid JSON naming the local url', () => {
  const s = JSON.parse(mcpConfigSnippet('http://127.0.0.1:47613/mcp'));
  assert.deepEqual(s, { mcpServers: { tangent: { type: 'http', url: 'http://127.0.0.1:47613/mcp' } } });
});
