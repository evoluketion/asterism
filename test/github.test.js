'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const gh = require('../src/main/github');

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const gitTest = hasGit ? test : test.skip;

const ok = out => ({ ok: true, out: typeof out === 'string' ? out : JSON.stringify(out), err: '', code: 0 });
const fail = (err, code = 1) => ({ ok: false, out: '', err, code });

/** A runner that answers from `routes` (first matching prefix of "cmd args…") and records each call. */
function fakeRun(routes) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    const line = [cmd, ...args].join(' ');
    calls.push({ line, args, opts });
    for (const [prefix, res] of routes) if (line.startsWith(prefix)) return typeof res === 'function' ? res(args) : res;
    throw new Error(`unexpected call: ${line}`);
  };
  return { run, calls };
}

const RAW_PR = {
  number: 7, title: 'Add a thing', url: 'https://github.com/o/r/pull/7', isDraft: true,
  author: { login: 'me' }, headRefName: 'feat/7-thing', headRefOid: 'abc123', baseRefName: 'main',
  reviewDecision: '', additions: 10, deletions: 2, updatedAt: '2026-11-12T00:00:00Z',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
};

function repoRoutes(extra = []) {
  return [
    ['git -C /w rev-parse --show-toplevel', ok('/repo\n')],
    ['git -C /repo remote', ok('origin\n')],
    ['git -C /repo branch --show-current', ok('feat/7-thing\n')],
    ['gh repo view', ok({ nameWithOwner: 'o/r', url: 'https://github.com/o/r' })],
    ['gh api --hostname github.com user', ok('me\n')],
    ...extra,
  ];
}

test.beforeEach(() => gh._viewers.clear());

test('summariseChecks counts check runs and status contexts', () => {
  assert.deepEqual(gh.summariseChecks([]), { state: 'none', passed: 0, failed: 0, pending: 0 });
  assert.deepEqual(gh.summariseChecks(null), { state: 'none', passed: 0, failed: 0, pending: 0 });
  assert.deepEqual(gh.summariseChecks([
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'StatusContext', state: 'SUCCESS' },
  ]), { state: 'pending', passed: 3, failed: 0, pending: 1 });
  assert.equal(gh.summariseChecks([
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'StatusContext', state: 'PENDING' },
  ]).state, 'failure');
  assert.equal(gh.summariseChecks([{ __typename: 'StatusContext', state: 'ERROR' }]).failed, 1);
});

test('normalisePr flattens gh fields', () => {
  const pr = gh.normalisePr(RAW_PR);
  assert.equal(pr.draft, true);
  assert.equal(pr.author, 'me');
  assert.equal(pr.review, null);
  assert.equal(pr.headOid, 'abc123');
  assert.equal(pr.checks.state, 'success');
  assert.equal(gh.normalisePr({ number: 1 }).mergeable, 'UNKNOWN');
});

test('classifyGhError sorts gh failures', () => {
  assert.equal(gh.classifyGhError({ code: 'ENOENT', err: '' }).kind, 'no-gh');
  assert.equal(gh.classifyGhError(fail('To get started with GitHub CLI, please run:  gh auth login', 4)).kind, 'auth');
  assert.equal(gh.classifyGhError(fail('none of the git remotes configured for this repository point to a known GitHub host')).kind, 'no-remote');
  assert.equal(gh.classifyGhError(fail('please run `gh repo set-default` to select a default remote')).kind, 'ambiguous-remote');
  const other = gh.classifyGhError(fail('GraphQL: something broke'));
  assert.deepEqual(other, { kind: 'other', message: 'GraphQL: something broke' });
});

test('ghEnv stops gh from prompting', () => {
  const env = gh.ghEnv({ PATH: '/bin' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.GH_PROMPT_DISABLED, '1');
});

test('prsOf lists the branch PRs against the resolved repo', async () => {
  const { run, calls } = fakeRun(repoRoutes([['gh pr list', ok([RAW_PR])]]));
  const d = await gh.prsOf('/w', { scope: 'branch', run, env: {} });
  assert.equal(d.error, undefined);
  assert.equal(d.root, '/repo');
  assert.equal(d.branch, 'feat/7-thing');
  assert.equal(d.repo.slug, 'github.com/o/r');
  assert.equal(d.viewer, 'me');
  assert.equal(d.prs.length, 1);
  const list = calls.find(c => c.line.startsWith('gh pr list'));
  assert.deepEqual(list.args.slice(0, 4), ['pr', 'list', '-R', 'github.com/o/r']);
  assert.ok(list.args.includes('--head') && list.args[list.args.indexOf('--head') + 1] === 'feat/7-thing');
  assert.equal(list.opts.env.GH_PROMPT_DISABLED, '1');
});

test('prsOf with scope all lists every open PR', async () => {
  const { run, calls } = fakeRun(repoRoutes([['gh pr list', ok([RAW_PR, { ...RAW_PR, number: 8 }])]]));
  const d = await gh.prsOf('/w', { scope: 'all', run, env: {} });
  assert.equal(d.prs.length, 2);
  assert.ok(!calls.find(c => c.line.startsWith('gh pr list')).args.includes('--head'));
});

test('prsOf on a detached HEAD lists nothing for the branch without asking gh', async () => {
  const routes = repoRoutes().map(([p, r]) => p.includes('branch --show-current') ? [p, ok('')] : [p, r]);
  const { run, calls } = fakeRun(routes);
  const d = await gh.prsOf('/w', { scope: 'branch', run, env: {} });
  assert.equal(d.branch, null);
  assert.deepEqual(d.prs, []);
  assert.ok(!calls.some(c => c.line.startsWith('gh pr list')));
});

test('prsOf reports a missing gh', async () => {
  const routes = repoRoutes().map(([p, r]) => p === 'gh repo view' ? [p, { ok: false, out: '', err: '', code: 'ENOENT' }] : [p, r]);
  const d = await gh.prsOf('/w', { run: fakeRun(routes).run, env: {} });
  assert.equal(d.kind, 'no-gh');
  assert.equal(d.root, '/repo');
});

test('prsOf caches the viewer only after a successful lookup', async () => {
  let lookups = 0;
  let answer = fail('HTTP 502');
  const routes = repoRoutes([['gh pr list', ok([])]]).map(([p, r]) => p.startsWith('gh api') ? [p, () => { lookups++; return answer; }] : [p, r]);
  const { run } = fakeRun(routes);
  assert.equal((await gh.prsOf('/w', { run, env: {} })).viewer, null);
  answer = ok('me\n');
  assert.equal((await gh.prsOf('/w', { run, env: {} })).viewer, 'me');
  assert.equal((await gh.prsOf('/w', { run, env: {} })).viewer, 'me');
  assert.equal(lookups, 2);
});

gitTest('prsOf on a real repo with no remote says so without running gh', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'asterism-gh-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { stdio: 'ignore' });
  const d = await gh.prsOf(dir);
  assert.equal(d.kind, 'no-remote');
  assert.equal(d.root, dir);
});

gitTest('prsOf outside a repo reports no-repo', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asterism-gh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal((await gh.prsOf(dir)).kind, 'no-repo');
});
