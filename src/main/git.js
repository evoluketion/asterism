'use strict';

const { execFile } = require('child_process');

const TTL_MS = 10000;
const cache = new Map();

function branchOf(cwd) {
  if (!cwd) return Promise.resolve(null);
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = new Promise(resolve => {
    execFile('git', ['-C', cwd, 'branch', '--show-current'], { timeout: 2000, windowsHide: true }, (err, out) => {
      resolve(err ? null : out.trim() || null);
    });
  });
  cache.set(cwd, { at: Date.now(), promise });
  return promise;
}

const DIFF_TIMEOUT_MS = 10000;

/** Runs git in `cwd`, resolving its stdout or null on failure. A stdout overflow resolves with what was read so far. */
function git(cwd, args, { maxBuffer = 8 * 1024 * 1024, input } = {}) {
  return new Promise(resolve => {
    const child = execFile('git', ['-c', 'core.quotepath=off', '-C', cwd, ...args],
      { timeout: DIFF_TIMEOUT_MS, windowsHide: true, maxBuffer },
      (err, out) => {
        if (!err) resolve({ out, overflow: false });
        else if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') resolve({ out, overflow: true });
        else resolve(null);
      });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Maps each changed path in `git status --porcelain=v1 -z` output to its two-letter code; untracked paths are listed separately. */
function parseStatus(out) {
  const codes = new Map();
  const untracked = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy === '??') untracked.push(path);
    else codes.set(path, xy);
    // A rename or copy is followed by its source path as a separate field.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return { codes, untracked };
}

/** Parses `git diff --numstat -z`; binary files report null counts. */
function parseNumstat(out) {
  const files = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    const added = m[1] === '-' ? null : Number(m[1]);
    const removed = m[2] === '-' ? null : Number(m[2]);
    if (m[3] === '') {
      files.push({ path: parts[i + 2], from: parts[i + 1], added, removed });
      i += 2;
    } else {
      files.push({ path: m[3], added, removed });
    }
  }
  return files;
}

/** Reduces a porcelain XY code to the one letter that describes the change against HEAD. */
function statusLetter(xy, renamed) {
  if (renamed) return 'R';
  if (!xy) return 'M';
  if (xy.includes('D')) return 'D';
  if (xy[0] === 'A') return 'A';
  return 'M';
}

/** Cuts `text` to at most `maxBytes` of UTF-8, ending on a line boundary. */
function truncate(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  const cut = buf.subarray(0, maxBytes).lastIndexOf(0x0a);
  return { text: buf.subarray(0, cut < 0 ? 0 : cut + 1).toString('utf8'), truncated: true };
}

/**
 * The working tree's changes against HEAD for the repo containing `cwd`, or null outside a repo.
 * A repo with no commits diffs against the empty tree, so staged files still show.
 */
async function diffOf(cwd, { maxBytes = 1_000_000 } = {}) {
  if (!cwd) return null;
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const root = top.out.trim();

  let base = 'HEAD';
  if (!(await git(root, ['rev-parse', '--verify', '-q', 'HEAD']))) {
    const empty = await git(root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' });
    if (!empty) return null;
    base = empty.out.trim();
  }

  const [branch, status, numstat, patch] = await Promise.all([
    git(root, ['branch', '--show-current']),
    git(root, ['status', '--porcelain=v1', '-z']),
    git(root, ['diff', base, '-M', '--numstat', '-z']),
    git(root, ['diff', base, '-M', '--no-color', '--no-ext-diff'], { maxBuffer: maxBytes * 4 }),
  ]);
  if (!status || !numstat || !patch) return null;

  const { codes, untracked } = parseStatus(status.out);
  const files = parseNumstat(numstat.out).map(f => ({
    path: f.path,
    status: statusLetter(codes.get(f.path), f.from !== undefined),
    added: f.added,
    removed: f.removed,
  }));
  const cut = truncate(patch.out.replace(/\r\n/g, '\n'), maxBytes);

  return {
    root,
    branch: branch?.out.trim() || null,
    files,
    untracked,
    patch: cut.text,
    truncated: cut.truncated || patch.overflow,
  };
}

module.exports = { branchOf, diffOf, parseStatus, parseNumstat };
