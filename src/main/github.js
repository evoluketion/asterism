'use strict';

const { execFile } = require('child_process');

const READ_TIMEOUT_MS = 20000;
const WRITE_TIMEOUT_MS = 60000;
const MERGE_METHODS = ['merge', 'squash', 'rebase'];
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
  const prs = raw.map(normalisePr).map(pr => ({ ...pr, plan: planSteps(pr, viewer) }));
  return { ...base, viewer, prs, limited: raw.length >= PR_LIMIT };
}

/**
 * The steps that land `pr`: take it out of draft, approve it, merge it. Approval is skipped for your
 * own PR, which GitHub refuses, and for one that is already approved.
 */
function planSteps(pr, viewer) {
  const steps = [];
  if (pr.draft) steps.push({ step: 'ready' });
  if (viewer && pr.author && viewer.toLowerCase() === pr.author.toLowerCase()) {
    steps.push({ step: 'approve', skip: "It's your own pull request, and GitHub doesn't let you approve those." });
  } else if (pr.review === 'APPROVED') {
    steps.push({ step: 'approve', skip: 'Already approved.' });
  } else {
    steps.push({ step: 'approve' });
  }
  steps.push({ step: 'merge' });
  return steps;
}

const STEP_ARGS = {
  ready: (n, slug) => ['pr', 'ready', n, '-R', slug],
  approve: (n, slug) => ['pr', 'review', n, '-R', slug, '--approve'],
  // Never --delete-branch: a worktree may still have the branch checked out.
  merge: (n, slug, { method, headOid }) => ['pr', 'merge', n, '-R', slug, `--${method}`, '--match-head-commit', headOid],
};

/**
 * Takes PR `number` out of draft, approves it and merges it with `method`, stopping at the first
 * step that fails. `headOid` is the head commit the user was shown: if anything was pushed since,
 * nothing runs, so a commit nobody saw can't be merged.
 * Resolves { ok, steps: [{ step, ok, skipped, message }], error?, kind? }.
 */
async function landPr(cwd, number, { method = 'merge', headOid, run = defaultRun, env = process.env } = {}) {
  env = ghEnv(env);
  const stop = (message, kind = 'other') => ({ ok: false, error: true, kind, message, steps: [] });
  if (!MERGE_METHODS.includes(method)) return stop(`Unknown merge method "${method}".`);
  if (!Number.isInteger(number) || number <= 0) return stop('Not a pull request number.');
  if (!headOid) return stop('Refresh the list and try again.');
  if (!cwd) return stop('The pane has no folder.', 'no-repo');
  const r = await repoOf(cwd, { run, env });
  if (r.error) return stop(r.message, r.kind);
  const n = String(number);
  const { slug, host } = r.repo;

  const view = await run('gh', ['pr', 'view', n, '-R', slug, '--json', 'state,isDraft,author,headRefOid,reviewDecision,mergeable'], { env });
  if (!view.ok) { const e = classifyGhError(view); return stop(e.message, e.kind); }
  let now;
  try { now = JSON.parse(view.out); } catch { return stop('gh returned something unreadable.'); }
  if (now.state !== 'OPEN') return stop(`#${n} is ${String(now.state || 'not open').toLowerCase()}.`);
  if (now.headRefOid !== headOid) return stop(`New commits were pushed to #${n} since the list was loaded. Refresh and check them first.`, 'moved');
  if (now.mergeable === 'CONFLICTING') return stop(`#${n} has merge conflicts with its base branch.`, 'conflict');

  const pr = normalisePr({ ...now, number });
  const viewer = await viewerOf(host, { run, env });
  const steps = [];
  for (const s of planSteps(pr, viewer)) {
    if (s.skip) { steps.push({ step: s.step, ok: true, skipped: true, message: s.skip }); continue; }
    const res = await run('gh', STEP_ARGS[s.step](n, slug, { method, headOid }), { env, timeout: WRITE_TIMEOUT_MS });
    const message = (res.ok ? (res.err || res.out) : classifyGhError(res).message).trim();
    steps.push({ step: s.step, ok: res.ok, skipped: false, message });
    if (!res.ok) return { ok: false, steps };
  }
  return { ok: true, steps };
}

/** The changed files in a unified diff, with the same shape git.diffOf returns. */
function parsePatchFiles(patch) {
  const files = [];
  let f = null;
  let inHeader = false;
  const strip = p => p.replace(/^"|"$/g, '').replace(/^[ab]\//, '');
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.*)$/.exec(line);
      f = { path: m ? m[1] : line.slice(11), status: 'M', added: 0, removed: 0 };
      files.push(f);
      inHeader = true;
      continue;
    }
    if (!f) continue;
    if (inHeader) {
      if (line.startsWith('@@')) inHeader = false;
      else if (line.startsWith('new file mode')) f.status = 'A';
      else if (line.startsWith('deleted file mode')) f.status = 'D';
      else if (line.startsWith('rename to ')) { f.status = 'R'; f.path = line.slice(10); }
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') f.path = strip(line.slice(4));
      else if (line.startsWith('--- ') && f.status === 'D' && line !== '--- /dev/null') f.path = strip(line.slice(4));
      else if (line.startsWith('Binary files ')) { f.added = null; f.removed = null; }
      continue;
    }
    if (line[0] === '+') f.added++;
    else if (line[0] === '-') f.removed++;
  }
  return files;
}

/** Cuts `text` to at most `maxBytes` of UTF-8, ending on a line boundary. */
function truncate(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  const cut = buf.subarray(0, maxBytes).lastIndexOf(0x0a);
  return { text: buf.subarray(0, cut < 0 ? 0 : cut + 1).toString('utf8'), truncated: true };
}

/** PR `number`'s diff against its base, as GitHub shows it: { files, untracked: [], patch, truncated } or an error. */
async function prDiff(cwd, number, { run = defaultRun, env = process.env, maxBytes = 1_000_000 } = {}) {
  env = ghEnv(env);
  if (!Number.isInteger(number) || number <= 0) return { error: true, kind: 'other', message: 'Not a pull request number.' };
  if (!cwd) return { error: true, kind: 'no-repo', message: 'The pane has no folder.' };
  const r = await repoOf(cwd, { run, env });
  if (r.error) return r;
  const res = await run('gh', ['pr', 'diff', String(number), '-R', r.repo.slug, '--color', 'never'], { env });
  if (!res.ok) return { error: true, ...classifyGhError(res) };
  const patch = res.out.replace(/\r\n/g, '\n');
  const cut = truncate(patch, maxBytes);
  return { files: parsePatchFiles(patch), untracked: [], patch: cut.text, truncated: cut.truncated };
}

module.exports = { prsOf, landPr, prDiff, parsePatchFiles, planSteps, MERGE_METHODS, classifyGhError, summariseChecks, normalisePr, hostOf, ghEnv, _viewers: viewers };
