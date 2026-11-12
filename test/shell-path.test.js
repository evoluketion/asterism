'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shellPath } = require('../src/main/shell');

const posixOnly = { skip: process.platform === 'win32' };

function fakeShell(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asterism-sh-'));
  const file = path.join(dir, 'fakesh');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

test('the shell\'s PATH comes first, then any of our own entries it lacks', posixOnly, async () => {
  const own = process.env.PATH;
  process.env.PATH = '/usr/bin:/only/ours';
  try {
    const sh = fakeShell(`echo "welcome banner"\necho __ASTERISM_ENV__\necho HOME=/h\necho PATH=/home/u/.local/bin:/usr/bin\necho __ASTERISM_ENV__`);
    assert.strictEqual(await shellPath(sh), '/home/u/.local/bin:/usr/bin:/only/ours');
  } finally {
    process.env.PATH = own;
  }
});

test('a shell that fails or prints no PATH falls back to our own', posixOnly, async () => {
  assert.strictEqual(await shellPath('/no/such/shell'), process.env.PATH);
  assert.strictEqual(await shellPath(fakeShell('exit 1')), process.env.PATH);
});
