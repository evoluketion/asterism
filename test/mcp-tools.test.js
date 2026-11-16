'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createToolHandler } = require('../src/main/mcp-tools');

function handler(order) {
  const snaps = [
    { id: 'p1', name: 'api', kind: 'claude', state: 'idle', since: Date.now(), cwd: '/w/api' },
    { id: 'p2', name: 'logs', kind: 'shell', state: 'shell', since: Date.now(), cwd: '/w' },
    { id: 'p3', name: 'new', kind: 'shell', state: 'shell', since: Date.now(), cwd: '/w' },
  ];
  const manager = {
    panes: new Map(snaps.map(s => [s.id, s])),
    list: () => snaps.map(s => ({ ...s })),
    get: id => ({ id, status: {} }),
    refreshBranch: async () => {},
  };
  const readScreen = async id => `screen of ${id}`;
  return createToolHandler({ manager, getOrder: () => order, readScreen });
}

test('list_panes numbers terminal panes by their place on screen, leaving gaps for browser panes', async () => {
  const h = handler(['p2', 'b1', 'p1']);
  const rows = JSON.parse(await h.callTool('p1', 'list_panes', {}));
  assert.deepStrictEqual(rows.map(r => [r.pane, r.name]), [[1, 'logs'], [3, 'api'], [4, 'new']]);
});

test('read_pane_screen resolves by on-screen number and by name', async () => {
  const h = handler(['p2', 'b1', 'p1']);
  assert.match(await h.callTool('p1', 'read_pane_screen', { pane: '3' }), /^Pane 3 \(api\)[^]*screen of p1$/);
  assert.match(await h.callTool('p1', 'read_pane_screen', { pane: 'LOGS' }), /^Pane 1 \(logs\)[^]*screen of p2$/);
  assert.match(await h.callTool('p1', 'read_pane_screen', { pane: 4 }), /^Pane 4 \(new\)/);
});

test('a number that lands on a browser pane says so', async () => {
  const h = handler(['p2', 'b1', 'p1']);
  await assert.rejects(h.callTool('p1', 'read_pane_screen', { pane: '2' }), /Pane 2 is not a terminal pane\./);
  await assert.rejects(h.callTool('p1', 'read_pane_screen', { pane: '9' }), /No pane "9"/);
});
