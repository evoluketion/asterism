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

module.exports = { branchOf };
