'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { variantFromBranch } = require('../src/main/variant');

test('variantFromBranch takes the issue number from an issue branch', () => {
  assert.equal(variantFromBranch('feat/2-per-pane-git-diff'), '2');
  assert.equal(variantFromBranch('fix/117-empty-csv'), '117');
  assert.equal(variantFromBranch('main'), null);
  assert.equal(variantFromBranch('feat/dark-mode'), null);
  assert.equal(variantFromBranch(''), null);
  assert.equal(variantFromBranch(null), null);
});
