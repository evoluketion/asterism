'use strict';

const { execFileSync } = require('child_process');

/** The issue number from a branch named `<type>/<issue>-<summary>`, or null. */
function variantFromBranch(branch) {
  const m = /^[\w.-]+\/(\d+)-/.exec(branch || '');
  return m ? m[1] : null;
}

/** The issue number of the branch checked out in `dir`, or null. */
function detectVariant(dir) {
  try {
    const branch = execFileSync('git', ['-C', dir, 'branch', '--show-current'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return variantFromBranch(branch.trim());
  } catch {
    return null;
  }
}

module.exports = { variantFromBranch, detectVariant };
