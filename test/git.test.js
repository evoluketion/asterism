'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { diffOf, parseStatus, parseNumstat } = require('../src/main/git');

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const gitTest = hasGit ? test : test.skip;

function sh(cwd, ...args) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { stdio: 'ignore' });
}

function makeRepo(t, { commit = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'asterism-git-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  sh(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  if (commit) {
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'init');
  }
  return dir;
}

test('parseStatus splits untracked and skips rename sources', () => {
  const { codes, untracked } = parseStatus(' M a.txt\0R  new name.txt\0old name.txt\0?? fresh file.txt\0A  b.txt\0');
  assert.deepEqual([...codes], [['a.txt', ' M'], ['new name.txt', 'R '], ['b.txt', 'A ']]);
  assert.deepEqual(untracked, ['fresh file.txt']);
});

test('parseNumstat handles renames, spaces and binary files', () => {
  const files = parseNumstat('3\t1\ta b.txt\0-\t-\timg.png\0' + '0\t0\t\0old.txt\0new.txt\0');
  assert.deepEqual(files, [
    { path: 'a b.txt', added: 3, removed: 1 },
    { path: 'img.png', added: null, removed: null },
    { path: 'new.txt', from: 'old.txt', added: 0, removed: 0 },
  ]);
});

gitTest('diffOf reports modified, staged and untracked files', async t => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'x\n');
  sh(dir, 'add', 'staged.txt');
  fs.writeFileSync(path.join(dir, 'loose file.txt'), 'y\n');
  fs.mkdirSync(path.join(dir, 'sub'));

  const d = await diffOf(path.join(dir, 'sub'));
  assert.equal(d.root, dir);
  assert.equal(d.branch, 'main');
  assert.deepEqual(d.files, [
    { path: 'a.txt', status: 'M', added: 2, removed: 1 },
    { path: 'staged.txt', status: 'A', added: 1, removed: 0 },
  ]);
  assert.deepEqual(d.untracked, ['loose file.txt']);
  assert.match(d.patch, /^\+TWO$/m);
  assert.equal(d.truncated, false);
});

gitTest('diffOf truncates the patch at a line boundary', async t => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'line\n'.repeat(1000));
  const d = await diffOf(dir, { maxBytes: 200 });
  assert.equal(d.truncated, true);
  assert.ok(Buffer.byteLength(d.patch) <= 200);
  assert.ok(d.patch.endsWith('\n'));
  assert.equal(d.files[0].added, 1000);
});

gitTest('diffOf works before the first commit', async t => {
  const dir = makeRepo(t, { commit: false });
  sh(dir, 'add', 'a.txt');
  const d = await diffOf(dir);
  assert.deepEqual(d.files, [{ path: 'a.txt', status: 'A', added: 2, removed: 0 }]);
});

gitTest('diffOf returns null outside a repo', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asterism-nogit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(await diffOf(dir), null);
  assert.equal(await diffOf(null), null);
});

gitTest('each worktree reports its own diff', async t => {
  const dir = makeRepo(t);
  const wt = dir + '-wt';
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  sh(dir, 'worktree', 'add', '-q', '-b', 'other', wt);
  fs.writeFileSync(path.join(wt, 'only-in-wt.txt'), 'z\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');

  const main = await diffOf(dir);
  const other = await diffOf(wt);
  assert.equal(other.root, wt);
  assert.equal(other.branch, 'other');
  assert.deepEqual(other.files, []);
  assert.deepEqual(other.untracked, ['only-in-wt.txt']);
  assert.deepEqual(main.files.map(f => f.path), ['a.txt']);
  assert.deepEqual(main.untracked, []);
});
