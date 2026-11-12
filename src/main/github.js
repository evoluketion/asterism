'use strict';

const { execFile } = require('child_process');

const READ_TIMEOUT_MS = 20000;
const PR_LIMIT = 100;
const PR_FIELDS = [
  'number', 'title', 'url', 'isDraft', 'author', 'headRefName', 'headRefOid', 'baseRefName',
  'reviewDecision', 'statusCheckRollup', 'additions', 'deletions', 'updatedAt', 'mergeable', 'mergeStateStatus',
].join(',');

/** Runs a command, resolving { ok, out, err, code } and never rejecting. `code` is the exit code, or e.g. 'ENOENT'. */
function defaultRun(cmd, args, { cwd, env, timeout = READ_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, env, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out, stderr) => {
      resolve({ ok: !err, out: String(out || ''), err: String(stderr || (err && !err.code ? err.message : '') || '').trim(), code: err ? err.code ?? 1 : 0 });
    });
  });
}

/** gh must never stop to ask a question: there is no terminal to answer it in. */
function ghEnv(env = process.env) {
  return { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0' };
}

/** Sorts a failed gh call into a kind the panel can explain. */
function classifyGhError(res) {
  const err = (res && res.err) || '';
  if (res && res.code === 'ENOENT') return { kind: 'no-gh', message: 'The GitHub CLI (gh) is not installed or not on PATH.' };
  if (res && res.code === 4 || /gh auth login|not logged in|authentication required|HTTP 401/i.test(err)) {
    return { kind: 'auth', message: err || 'gh is not logged in.' };
  }
  if (/set-default/i.test(err)) return { kind: 'ambiguous-remote', message: err };
  if (/no git remotes|known GitHub host|could not determine (base )?repo/i.test(err)) return { kind: 'no-remote', message: err };
  return { kind: 'other', message: err || `gh exited with ${res ? res.code : 'an error'}` };
}

/** Collapses a PR's statusCheckRollup (CheckRuns and StatusContexts) into counts and one overall state. */
function summariseChecks(rollup) {
  let passed = 0, failed = 0, pending = 0;
  for (const c of Array.isArray(rollup) ? rollup : []) {
    const result = c.__typename === 'StatusContext' || (c.state && !c.status) ? c.state : (c.status === 'COMPLETED' ? c.conclusion : 'PENDING');
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(result)) passed++;
    else if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', null, undefined, ''].includes(result)) pending++;
    else failed++;
  }
  const state = failed ? 'failure' : pending ? 'pending' : passed ? 'success' : 'none';
  return { state, passed, failed, pending };
}

function normalisePr(raw) {
  return {
    number: raw.number,
    title: raw.title || '',
    url: raw.url || '',
    draft: !!raw.isDraft,
    author: (raw.author && raw.author.login) || '',
    headRef: raw.headRefName || '',
    headOid: raw.headRefOid || '',
    baseRef: raw.baseRefName || '',
    review: raw.reviewDecision || null,
    checks: summariseChecks(raw.statusCheckRollup),
    additions: raw.additions ?? null,
    deletions: raw.deletions ?? null,
    updatedAt: raw.updatedAt || null,
    mergeable: raw.mergeable || 'UNKNOWN',
    mergeState: raw.mergeStateStatus || 'UNKNOWN',
  };
}

/** `https://github.com/owner/repo` → `github.com`. */
function hostOf(url) {
  try { return new URL(url).host || 'github.com'; } catch { return 'github.com'; }
}

const viewers = new Map();

/** The logged-in gh user for `host`. Only a successful lookup is cached. */
async function viewerOf(host, { run, env }) {
  if (viewers.has(host)) return viewers.get(host);
  const res = await run('gh', ['api', '--hostname', host, 'user', '--jq', '.login'], { env });
  if (!res.ok) return null;
  const login = res.out.trim() || null;
  if (login) viewers.set(host, login);
  return login;
}

/** The GitHub repo for the git repo containing `cwd`: { root, branch, repo } or { root?, error, kind, message }. */
async function repoOf(cwd, { run, env }) {
  const top = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { env });
  if (!top.ok) return { error: true, kind: 'no-repo', message: 'Not a git repository.' };
  const root = top.out.trim();
  // Checked before gh starts, so a repo with no remote gets the same answer with or without gh.
  const remotes = await run('git', ['-C', root, 'remote'], { env });
  if (!remotes.ok || !remotes.out.trim()) return { root, error: true, kind: 'no-remote', message: 'This repository has no remote, so it has no pull requests.' };
  const branch = (await run('git', ['-C', root, 'branch', '--show-current'], { env })).out.trim() || null;
  const view = await run('gh', ['repo', 'view', '--json', 'nameWithOwner,url'], { cwd: root, env });
  if (!view.ok) {
    const e = classifyGhError(view);
    if (e.kind === 'auth') viewers.clear();
    return { root, branch, error: true, ...e };
  }
  let info;
  try { info = JSON.parse(view.out); } catch { return { root, branch, error: true, kind: 'other', message: 'gh returned something unreadable.' }; }
  const host = hostOf(info.url);
  return { root, branch, repo: { name: info.nameWithOwner, url: info.url, host, slug: `${host}/${info.nameWithOwner}` } };
}

/**
 * Open pull requests for the repo containing `cwd`: those from its current branch (`scope: 'branch'`)
 * or all of them (`scope: 'all'`).
 */
async function prsOf(cwd, { scope = 'branch', run = defaultRun, env = process.env } = {}) {
  env = ghEnv(env);
  if (!cwd) return { scope, error: true, kind: 'no-repo', message: 'The pane has no folder.' };
  const r = await repoOf(cwd, { run, env });
  if (r.error) return { scope, ...r };
  const { root, branch, repo } = r;
  const base = { root, branch, repo, scope };
  if (scope === 'branch' && !branch) return { ...base, viewer: null, prs: [] };

  const args = ['pr', 'list', '-R', repo.slug, '--state', 'open', '--limit', String(PR_LIMIT), '--json', PR_FIELDS];
  if (scope === 'branch') args.push('--head', branch);
  const [list, viewer] = await Promise.all([run('gh', args, { cwd: root, env }), viewerOf(repo.host, { run, env })]);
  if (!list.ok) return { ...base, error: true, ...classifyGhError(list) };
  let raw;
  try { raw = JSON.parse(list.out); } catch { return { ...base, error: true, kind: 'other', message: 'gh returned something unreadable.' }; }
  const prs = raw.map(normalisePr);
  return { ...base, viewer, prs, limited: raw.length >= PR_LIMIT };
}

module.exports = { prsOf, classifyGhError, summariseChecks, normalisePr, hostOf, ghEnv, _viewers: viewers };
