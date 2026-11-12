'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, commonDir } = require('../src/main/store');

test('commonDir picks the folder most panes share', () => {
  assert.strictEqual(commonDir({ panes: [{ cwd: '/a' }, { cwd: '/b' }, { cwd: '/b' }] }), '/b');
  assert.strictEqual(commonDir({ panes: [] }), '');
  assert.strictEqual(commonDir(null), '');
});

test('old workspaces become projects and old folder settings are dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asterism-store-'));
  const layout = { preset: 'grid', panes: [{ kind: 'claude', cwd: '/w/api' }, { kind: 'claude', cwd: '/w/api' }, { kind: 'shell', cwd: '/w' }] };
  fs.writeFileSync(path.join(dir, 'asterism-state.json'), JSON.stringify({
    settings: { defaultCwd: '/home/x', setupDone: true, fontSize: 15 },
    workspaces: { api: layout },
  }));
  const store = new Store(dir);
  const projects = Object.values(store.data.projects);
  assert.strictEqual(projects.length, 1);
  assert.strictEqual(projects[0].name, 'api');
  assert.strictEqual(projects[0].dir, '/w/api');
  assert.deepStrictEqual(projects[0].layout, layout);
  assert.strictEqual(store.data.workspaces, undefined);
  assert.strictEqual(store.settings.defaultCwd, undefined);
  assert.strictEqual(store.settings.setupDone, undefined);
  assert.strictEqual(store.settings.fontSize, 15);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fresh store has no projects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asterism-store-'));
  const store = new Store(dir);
  assert.deepStrictEqual(store.data.projects, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fresh store has an empty archive with summarising off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asterism-store-'));
  const store = new Store(dir);
  assert.deepStrictEqual(store.data.archive, []);
  assert.strictEqual(store.settings.archiveCompleted, false);
  assert.strictEqual(store.settings.summaryPrompt, '');
  assert.strictEqual(store.settings.summaryModel, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('archive entries are added newest first, updated, removed and dropped with their project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asterism-store-'));
  const store = new Store(dir);
  store.addArchived({ id: 'a', project: 'p1', summaryState: 'pending' });
  store.addArchived({ id: 'b', project: 'p2', summaryState: 'none' });
  store.addArchived({ id: 'c', project: 'p1', summaryState: 'none' });
  assert.deepStrictEqual(store.data.archive.map(e => e.id), ['c', 'b', 'a']);
  store.updateArchived('a', { summaryState: 'done', summary: 'S' });
  assert.deepStrictEqual(store.data.archive[2], { id: 'a', project: 'p1', summaryState: 'done', summary: 'S' });
  store.removeArchived('c');
  assert.deepStrictEqual(store.data.archive.map(e => e.id), ['b', 'a']);
  store.dropArchivedForProject('p1');
  store.saveNow();
  assert.deepStrictEqual(new Store(dir).data.archive.map(e => e.id), ['b']);
  fs.rmSync(dir, { recursive: true, force: true });
});
