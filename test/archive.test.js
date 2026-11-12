'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { EventEmitter } = require('events');
const { buildEntry, draftSummary, summarise, contextPrompt, SUMMARY_PROMPT } = require('../src/main/archive');

const snap = { name: 'api', autoName: false, cwd: '/w/api/src', startCwd: '/w/api', branch: 'main', sessionId: 's1', openedAt: 5 };

test('buildEntry prefers the start folder and nulls an auto name', () => {
  const e = buildEntry({ ...snap, autoName: true }, { project: 'p1', now: 9, summarised: true });
  assert.strictEqual(e.cwd, '/w/api');
  assert.strictEqual(e.name, null);
  assert.strictEqual(e.summaryState, 'pending');
  assert.strictEqual(e.branch, 'main');
  assert.strictEqual(e.sessionId, 's1');
  assert.strictEqual(e.openedAt, 5);
  assert.strictEqual(buildEntry({ ...snap, startCwd: null }).cwd, '/w/api/src');
});

test('an unsummarised entry holds only the name and folder', () => {
  const e = buildEntry(snap, { project: 'p1', now: 9, summarised: false });
  assert.deepStrictEqual(Object.keys(e).sort(), ['completedAt', 'cwd', 'id', 'name', 'project', 'summaryState']);
  assert.deepStrictEqual({ ...e, id: 'x' }, { id: 'x', project: 'p1', name: 'api', cwd: '/w/api', completedAt: 9, summaryState: 'none' });
});

// A stub child process: emits the given output then closes with `code`, unless `hang` is set.
function stubSpawn({ stdout = '', code = 0, hang = false } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    let input = '';
    child.stdin = { on() {}, end: s => { input = s; } };
    calls.push({ cmd, args, opts, get input() { return input; } });
    if (!hang) setImmediate(() => { if (stdout) child.stdout.emit('data', stdout); child.emit('close', code); });
    return child;
  };
  return { spawn, calls };
}

const run = (stub, extra = {}) => summarise({ claudeCommand: 'claude', sessionId: 's1', cwd: '/w/api', prompt: 'Sum it up', spawn: stub.spawn, ...extra });

test('summarise forks the session headlessly in its folder with the given prompt', { skip: process.platform === 'win32' }, async () => {
  const stub = stubSpawn({ stdout: ' summary \n' });
  assert.strictEqual(await run(stub), 'summary');
  const [c] = stub.calls;
  assert.strictEqual(c.cmd, 'claude');
  assert.deepStrictEqual(c.args, ['-p', '--resume', 's1', '--fork-session', '--output-format', 'text']);
  assert.strictEqual(c.opts.cwd, '/w/api');
  assert.strictEqual(c.input, 'Sum it up');
});

test('a blank prompt sends the built-in one', { skip: process.platform === 'win32' }, async () => {
  const stub = stubSpawn({ stdout: 'x' });
  await run(stub, { prompt: '' });
  assert.strictEqual(stub.calls[0].input, SUMMARY_PROMPT);
});

test('summarise passes --model only when one is set', { skip: process.platform === 'win32' }, async () => {
  const stub = stubSpawn({ stdout: 'x' });
  await run(stub, { model: 'sonnet' });
  await run(stub, { model: '' });
  assert.deepStrictEqual(stub.calls[0].args.slice(-2), ['--model', 'sonnet']);
  assert.ok(!stub.calls[1].args.includes('--model'));
});

test('summarise splits a command with arguments', { skip: process.platform === 'win32' }, async () => {
  const stub = stubSpawn({ stdout: 'x' });
  await run(stub, { claudeCommand: 'node /x/fake.js' });
  assert.strictEqual(stub.calls[0].cmd, 'node');
  assert.strictEqual(stub.calls[0].args[0], '/x/fake.js');
});

test('summarise rejects a failed run, empty output, a timeout and a bad model', async () => {
  await assert.rejects(run(stubSpawn({ stdout: 'x', code: 1 })));
  await assert.rejects(run(stubSpawn({ stdout: '  \n' })), /empty/);
  const hung = stubSpawn({ hang: true });
  await assert.rejects(run(hung, { timeoutMs: 10 }), /Timed out/);
  await assert.rejects(run(stubSpawn(), { model: 'x; rm -rf /' }), /Invalid model/);
  await assert.rejects(run(stubSpawn(), { sessionId: null }), /No session/);
});

test('summarise runs the fake claude end to end', async () => {
  const fake = path.join(__dirname, 'fake-claude.js');
  const out = await summarise({ claudeCommand: `${process.execPath} ${fake}`, sessionId: 's1', cwd: __dirname, prompt: SUMMARY_PROMPT });
  assert.match(out, /^Fake summary of s1/);
});

test('draftSummary keeps the first prompt and the last reply, capped', () => {
  const turns = [
    { role: 'user', text: 'first' }, { role: 'assistant', text: 'a1' },
    { role: 'user', text: 'second' }, { role: 'tool', name: 'Edit' }, { role: 'assistant', text: 'a2' },
  ];
  assert.strictEqual(draftSummary(turns), 'First prompt:\nfirst\n\nLast reply:\na2');
  assert.strictEqual(draftSummary(turns, 'live'), 'First prompt:\nfirst\n\nLast reply:\nlive');
  const long = draftSummary([{ role: 'user', text: 'p'.repeat(5000) }], 'r'.repeat(5000));
  assert.ok(long.includes('p'.repeat(1500) + '…') && !long.includes('p'.repeat(1501)));
  assert.ok(long.includes('r'.repeat(3000) + '…') && !long.includes('r'.repeat(3001)));
  assert.strictEqual(draftSummary([], null), 'No conversation was recorded.');
});

test('contextPrompt wraps the summary for a fresh session', () => {
  const text = contextPrompt('  Did the auth refactor.\n');
  assert.match(text, /^You are picking up work from a previous session\. Summary:\n\nDid the auth refactor\.\n\n/);
  assert.match(text, /wait for the user's instructions/);
});

test('summarise strips nested-session markers from the environment', { skip: process.platform === 'win32' }, async () => {
  process.env.CLAUDECODE = '1';
  try {
    const stub = stubSpawn({ stdout: 'x' });
    await run(stub);
    assert.strictEqual(stub.calls[0].opts.env.CLAUDECODE, undefined);
    assert.strictEqual(stub.calls[0].opts.env.PATH, process.env.PATH);
  } finally {
    delete process.env.CLAUDECODE;
  }
});

test('an aborted summary rejects and stops the run', async () => {
  const ctrl = new AbortController();
  const fake = path.join(__dirname, 'fake-claude.js');
  const p = summarise({ claudeCommand: `${process.execPath} ${fake}`, sessionId: 's1', cwd: __dirname, prompt: 'x', signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p);
});

test('summarise expands a leading ~/ in the claude command and uses the given env', { skip: process.platform === 'win32' }, async () => {
  const stub = stubSpawn({ stdout: 'x' });
  await run(stub, { claudeCommand: '~/bin/claude', env: { PATH: '/p' } });
  assert.strictEqual(stub.calls[0].cmd, path.join(require('os').homedir(), 'bin/claude'));
  assert.deepStrictEqual(stub.calls[0].opts.env, { PATH: '/p' });
});
