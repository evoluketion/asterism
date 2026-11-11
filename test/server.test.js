'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/main/server');

async function setup() {
  const hooks = [];
  const srv = createServer({
    hook: (...a) => hooks.push(a),
    tools: [{ name: 'echo', description: 'x', inputSchema: { type: 'object' } }],
    callTool: async (pane, name, args) => `${pane}:${args.v}`,
  });
  const port = await srv.listen();
  const url = p => `http://127.0.0.1:${port}${p}`;
  const auth = { Authorization: `Bearer ${srv.tokenFor('p1')}` };
  const auth2 = { Authorization: `Bearer ${srv.tokenFor('p2')}` };
  return { srv, hooks, url, auth, auth2 };
}

test('hook auth, routing and empty 204', async () => {
  const { srv, hooks, url, auth } = await setup();
  let r = await fetch(url('/hook/p1/Stop'), { method: 'POST', body: '{}' });
  assert.equal(r.status, 401);
  r = await fetch(url('/hook/p1/Stop'), { method: 'POST', headers: auth, body: '{"session_id":"s"}' });
  assert.equal(r.status, 204);
  assert.equal(await r.text(), '');
  assert.deepEqual(hooks, [['p1', 'Stop', { session_id: 's' }]]);
  r = await fetch(url('/hook/p1/Stop'), { method: 'POST', headers: { ...auth, Origin: 'http://evil.example' }, body: '{}' });
  assert.equal(r.status, 403);
  r = await fetch(url('/hook/p2/Stop'), { method: 'POST', headers: auth, body: '{}' });
  assert.equal(r.status, 401, 'pane 1 token must not work for pane 2');
  r = await fetch(url('/hook/p1/Stop'), { method: 'POST', headers: auth, body: 'null' });
  assert.equal(r.status, 204);
  srv.close();
});

test('mcp initialize, notifications, tools', async () => {
  const { srv, url, auth2: auth } = await setup();
  const post = body => fetch(url('/mcp/p2'), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  assert.equal((await r.json()).result.protocolVersion, '2025-06-18');
  r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(r.status, 202);
  r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { v: 7 } } });
  assert.equal((await r.json()).result.content[0].text, 'p2:7');
  r = await post({ jsonrpc: '2.0', id: 3, method: 'nope' });
  assert.equal((await r.json()).error.code, -32601);
  r = await fetch(url('/mcp/p2'), { headers: auth });
  assert.equal(r.status, 405);
  srv.close();
});
