'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('sessionSaved only resumes sessions that have a transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asterism-cfg-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const { sessionSaved } = require('../src/main/panes');
  try {
    // No projects folder at all: can't tell, so allow the resume.
    assert.strictEqual(sessionSaved('abc-123'), true);
    fs.mkdirSync(path.join(dir, 'projects', '-home-x-repo'), { recursive: true });
    assert.strictEqual(sessionSaved('abc-123'), false);
    fs.writeFileSync(path.join(dir, 'projects', '-home-x-repo', 'abc-123.jsonl'), '{}\n');
    assert.strictEqual(sessionSaved('abc-123'), true);
    assert.strictEqual(sessionSaved(null), false);
    assert.strictEqual(sessionSaved('../etc/passwd'), false);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
