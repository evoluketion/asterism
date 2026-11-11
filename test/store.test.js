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
