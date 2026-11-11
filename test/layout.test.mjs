import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/renderer/layout.js';

const ids = n => Array.from({ length: n }, (_, i) => `p${i + 1}`);

test('grid of 4 is 2x2 corners', () => {
  const t = L.buildPreset('grid', ids(4));
  assert.equal(t.dir, 'col');
  assert.equal(t.children.length, 2);
  for (const row of t.children) { assert.equal(row.dir, 'row'); assert.equal(row.children.length, 2); }
  assert.deepEqual(L.leafIds(t), ids(4));
});

test('grid of 5 is 3 + 2, order preserved', () => {
  const t = L.buildPreset('grid', ids(5));
  assert.deepEqual(t.children.map(r => L.leafIds(r).length), [3, 2]);
  assert.deepEqual(L.leafIds(t), ids(5));
});

test('single pane is a leaf for every preset', () => {
  for (const p of L.PRESETS) assert.deepEqual(L.buildPreset(p.id, ['a']), { type: 'pane', id: 'a' });
});

test('main-left puts first pane alone on the left', () => {
  const t = L.buildPreset('main-left', ids(4));
  assert.equal(t.dir, 'row');
  assert.deepEqual(t.children[0], { type: 'pane', id: 'p1' });
  assert.deepEqual(L.leafIds(t.children[1]), ['p2', 'p3', 'p4']);
});

test('removePane collapses and renormalizes', () => {
  let t = L.buildPreset('columns', ids(3));
  t = L.removePane(t, 'p2');
  assert.deepEqual(L.leafIds(t), ['p1', 'p3']);
  assert.ok(Math.abs(t.sizes.reduce((a, b) => a + b) - 1) < 1e-9);
  t = L.removePane(t, 'p1');
  assert.deepEqual(t, { type: 'pane', id: 'p3' });
  assert.equal(L.removePane(t, 'p3'), null);
});

test('swap and setSizesAt', () => {
  let t = L.buildPreset('grid', ids(4));
  t = L.swapPanes(t, 'p1', 'p4');
  assert.deepEqual(L.leafIds(t), ['p4', 'p2', 'p3', 'p1']);
  t = L.setSizesAt(t, [0], [3, 1]);
  assert.deepEqual(t.children[0].sizes, [0.75, 0.25]);
});

test('splitPane inserts beside target', () => {
  const t = L.splitPane(L.buildPreset('columns', ids(2)), 'p1', 'x', 'row');
  assert.deepEqual(L.leafIds(t), ['p1', 'x', 'p2']);
});

test('findNeighbor on a 2x2 grid', () => {
  const r = { a: { x: 0, y: 0, w: 100, h: 100 }, b: { x: 100, y: 0, w: 100, h: 100 }, c: { x: 0, y: 100, w: 100, h: 100 }, d: { x: 100, y: 100, w: 100, h: 100 } };
  assert.equal(L.findNeighbor(r, 'a', 'right'), 'b');
  assert.equal(L.findNeighbor(r, 'a', 'down'), 'c');
  assert.equal(L.findNeighbor(r, 'd', 'up'), 'b');
  assert.equal(L.findNeighbor(r, 'a', 'left'), null);
});

test('waitingOrder: blocked first, then oldest', () => {
  const o = L.waitingOrder({
    a: { state: 'ready', needsYou: true, since: 1 },
    b: { state: 'working', needsYou: false, since: 0 },
    c: { state: 'permission', needsYou: true, since: 5 },
    d: { state: 'ready', needsYou: true, since: 0 },
  });
  assert.deepEqual(o, ['c', 'd', 'a']);
});
