'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaneStatus, STALL_QUIET_MS, BACKGROUND_QUIET_MS } = require('../src/main/status');

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

test('Stop with running background tasks keeps the pane working', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('UserPromptSubmit', {}, 0);
  s.onOutput(0);
  const running = [{ id: 'a1', type: 'subagent', status: 'running', description: 'explore' }];
  s.applyHook('Stop', { last_assistant_message: 'started', background_tasks: running }, 1);
  assert.equal(s.state, 'working');
  assert.equal(s.needsYou, false);
  assert.equal(s.lastReply, 'started');
  s.tick(STALL_QUIET_MS * 2);
  assert.equal(s.state, 'working');
  s.applyHook('Notification', { notification_type: 'idle_prompt' }, 60001);
  assert.equal(s.state, 'working');
  s.applyHook('PreToolUse', { tool_name: 'Grep', agent_id: 'a1' }, 60002);
  s.applyHook('PostToolUse', { agent_id: 'a1' }, 60003);
  assert.equal(s.state, 'working');
  s.applyHook('Stop', { last_assistant_message: 'done', background_tasks: [] }, 70000);
  assert.equal(s.state, 'ready');
  assert.ok(s.needsYou);
});

test('Stop without background_tasks sets ready', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('UserPromptSubmit', {}, 0);
  s.applyHook('Stop', {}, 1);
  assert.equal(s.state, 'ready');
});

test('a running monitor alone does not keep the pane working', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('UserPromptSubmit', {}, 0);
  const tasks = [{ id: 'm1', type: 'monitor', status: 'running', description: 'wait for CI' }];
  s.applyHook('Stop', { background_tasks: tasks }, 1);
  assert.equal(s.state, 'ready');
});

test('a new prompt clears the background flag so the stall fallback works again', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('Stop', { background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] }, 0);
  s.applyHook('UserPromptSubmit', {}, 1);
  s.onOutput(1);
  s.tick(STALL_QUIET_MS + 2);
  assert.equal(s.state, 'ready');
  assert.ok(s.inferred);
});

test('finished background tasks do not keep the pane working', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('UserPromptSubmit', {}, 0);
  s.applyHook('Stop', { background_tasks: [{ id: 'a1', type: 'subagent', status: 'completed' }] }, 1);
  assert.equal(s.state, 'ready');
});

test('Esc at the prompt while background work runs is not an interrupt', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('UserPromptSubmit', {}, 0);
  s.applyHook('Stop', { background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] }, 1);
  s.onOutput(1);
  s.onInput('\x1b', 1);
  s.tick(5000);
  assert.equal(s.state, 'working');
  assert.equal(s.inferred, null);
});

test('background work with no hook events for the timeout counts as done', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('UserPromptSubmit', {}, 0);
  s.applyHook('Stop', { background_tasks: [{ id: 'b1', type: 'shell', status: 'running', command: 'npm run dev' }] }, 1);
  s.tick(BACKGROUND_QUIET_MS);
  assert.equal(s.state, 'working');
  s.tick(BACKGROUND_QUIET_MS + 1);
  assert.equal(s.state, 'ready');
  assert.ok(s.inferred);
  assert.equal(s.backgroundRunning, false);
});

test('subagent hooks keep the background timeout from firing', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('Stop', { background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] }, 0);
  const t = BACKGROUND_QUIET_MS - 1000;
  s.applyHook('PreToolUse', { tool_name: 'Read', agent_id: 'a1' }, t);
  s.tick(t + BACKGROUND_QUIET_MS - 1);
  assert.equal(s.state, 'working');
});

test('a background timeout of 0 waits indefinitely', () => {
  const s = new PaneStatus('claude', 0);
  s.applyHook('Stop', { background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] }, 0);
  s.tick(BACKGROUND_QUIET_MS * 100, 0);
  assert.equal(s.state, 'working');
});
