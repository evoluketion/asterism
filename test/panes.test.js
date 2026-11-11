'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaneManager } = require('../src/main/panes');

function withManager(fn) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asterism-rt-'));
  const manager = new PaneManager({
    runtimeDir,
    server: { port: 0, tokenFor: () => '' },
    getSettings: () => ({ claudeCommand: 'claude', shell: '' }),
  });
  try {
    fn(manager, runtimeDir);
  } finally {
    manager.killAll();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

test('a pane without a name takes its folder name and follows it', () => {
  withManager((manager, dir) => {
    const snap = manager.create({ kind: 'claude', cwd: dir });
    assert.strictEqual(snap.name, path.basename(dir));
    assert.strictEqual(snap.autoName, true);
  });
});

test('a named pane keeps its name', () => {
  withManager((manager, dir) => {
    const snap = manager.create({ kind: 'claude', name: 'api', cwd: dir });
    assert.strictEqual(snap.name, 'api');
    assert.strictEqual(snap.autoName, false);
  });
});

test('renaming sets a chosen name, cleaned and capped at 60 characters', () => {
  withManager((manager, dir) => {
    const { id } = manager.create({ kind: 'claude', cwd: dir });
    manager.rename(id, '  api\x1b[31m\n ');
    assert.strictEqual(manager.get(id).name, 'api[31m');
    assert.strictEqual(manager.get(id).autoName, false);
    manager.rename(id, 'x'.repeat(100));
    assert.strictEqual(manager.get(id).name, 'x'.repeat(60));
  });
});

test('clearing a name goes back to the folder name', () => {
  withManager((manager, dir) => {
    const { id } = manager.create({ kind: 'shell', name: 'build', cwd: dir });
    for (const blank of ['', '   ', '\x07']) {
      manager.rename(id, 'build');
      manager.rename(id, blank);
      assert.strictEqual(manager.get(id).name, `${path.basename(dir)} (shell)`);
      assert.strictEqual(manager.get(id).autoName, true);
    }
  });
});

test('confirming the current default name keeps it following the folder', () => {
  withManager((manager, dir) => {
    const { id, name } = manager.create({ kind: 'claude', cwd: dir });
    manager.rename(id, name);
    assert.strictEqual(manager.get(id).autoName, true);
  });
});

test('names given at creation are cleaned too', () => {
  withManager((manager, dir) => {
    assert.strictEqual(manager.create({ kind: 'claude', name: ' a\x1bb ', cwd: dir }).name, 'ab');
    const blank = manager.create({ kind: 'claude', name: '\x07', cwd: dir });
    assert.strictEqual(blank.autoName, true);
  });
});

test('a cut name loses trailing spaces and non-string names are ignored', () => {
  withManager((manager, dir) => {
    const { id } = manager.create({ kind: 'claude', name: 'keep', cwd: dir });
    manager.rename(id, 'a'.repeat(59) + ' b');
    assert.strictEqual(manager.get(id).name, 'a'.repeat(59));
    manager.rename(id, undefined);
    manager.rename(id, {});
    assert.strictEqual(manager.get(id).name, 'a'.repeat(59));
    assert.strictEqual(manager.get(id).autoName, false);
  });
});

test('a shell pane running Claude clears to the Claude-style folder name', () => {
  withManager((manager, dir) => {
    const { id } = manager.create({ kind: 'shell', name: 'x', cwd: dir });
    manager.hook(id, 'SessionStart', { cwd: dir, session_id: 's1', source: 'startup' });
    manager.rename(id, '');
    assert.strictEqual(manager.get(id).name, path.basename(dir));
  });
});
