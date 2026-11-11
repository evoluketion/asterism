'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaneStatus } = require('../src/main/status');

test('happy path through a turn', () => {
  const s = new PaneStatus('claude', 0);
  assert.equal(s.state, 'starting');
  s.applyHook('SessionStart', { session_id: 'abc', source: 'startup' }, 1);
  assert.equal(s.state, 'idle');
  assert.equal(s.sessionId, 'abc');
  s.applyHook('UserPromptSubmit', { prompt: 'hi' }, 2);
  assert.equal(s.state, 'working');
  s.applyHook('PreToolUse', { tool_name: 'Bash' }, 3);
  assert.equal(s.currentTool, 'Bash');
  s.applyHook('PermissionRequest', {}, 4);
  assert.equal(s.state, 'permission');
  s.applyHook('PostToolUse', {}, 5);
  assert.equal(s.state, 'working');
  s.applyHook('Stop', { last_assistant_message: 'done' }, 6);
  assert.equal(s.state, 'ready');
  assert.equal(s.lastReply, 'done');
  assert.ok(s.needsYou);
  s.onInput('x', 7);
  assert.equal(s.state, 'idle');
});

test('compaction SessionStart keeps working', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('UserPromptSubmit', {}, 1);
  s.applyHook('SessionStart', { source: 'compact' }, 2);
  assert.equal(s.state, 'working');
});

test('AskUserQuestion and ExitPlanMode are questions', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('PreToolUse', { tool_name: 'AskUserQuestion' }, 1);
  assert.equal(s.state, 'question');
  s.applyHook('PostToolUse', {}, 2);
  s.applyHook('PreToolUse', { tool_name: 'ExitPlanMode' }, 3);
  assert.equal(s.state, 'question');
});

test('idle_prompt does not re-light a seen pane', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('Stop', {}, 1);
  s.onInput('a', 2);
  assert.equal(s.state, 'idle');
  s.applyHook('Notification', { notification_type: 'idle_prompt' }, 3);
  assert.equal(s.state, 'idle');
});

test('StopFailure is an error that needs you', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('UserPromptSubmit', {}, 1);
  s.applyHook('StopFailure', { error: 'overloaded' }, 2);
  assert.equal(s.state, 'error');
  assert.equal(s.error, 'overloaded');
  assert.ok(s.needsYou);
});

test('Esc + quiet output → idle (interrupted)', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('UserPromptSubmit', {}, 0);
  s.onOutput(1000);
  s.onInput('\x1b', 1000);
  assert.equal(s.tick(2000), false);
  assert.equal(s.tick(2600), true);
  assert.equal(s.state, 'idle');
  assert.equal(s.inferred, 'interrupted');
});

test('Esc while output continues does nothing', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('UserPromptSubmit', {}, 0);
  s.onInput('\x1b', 1000);
  for (let t = 1100; t < 5000; t += 100) { s.onOutput(t); s.tick(t); }
  assert.equal(s.state, 'working');
});

test('Esc on a permission prompt then quiet → idle', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('PermissionRequest', {}, 0);
  s.onOutput(100);
  s.onInput('\x1b', 100);
  s.tick(1700);
  assert.equal(s.state, 'idle');
});

test('30s stall → inferred ready', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('UserPromptSubmit', {}, 0);
  s.onOutput(0);
  s.tick(29000);
  assert.equal(s.state, 'working');
  s.tick(30500);
  assert.equal(s.state, 'ready');
  assert.ok(s.inferred);
});

test('a shell pane becomes a claude pane when claude starts in it', () => {
  const s = new PaneStatus('shell', 0);
  assert.equal(s.state, 'shell');
  assert.equal(s.applyHook('SessionStart', { source: 'startup', cwd: '/proj', session_id: 'x' }, 1), true);
  assert.equal(s.kind, 'claude');
  assert.equal(s.state, 'idle');
  assert.equal(s.startCwd, '/proj');
  s.applyHook('SessionEnd', {}, 2);
  assert.equal(s.state, 'shell');
  assert.equal(s.kind, 'claude');
});

test('focus/mouse reports do not acknowledge ready', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('Stop', {}, 1);
  s.onInput('\x1b[I', 2);
  s.onInput('\x1b[<64;10;5M', 3);
  assert.equal(s.state, 'ready');
});
