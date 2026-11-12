'use strict';

const childProcess = require('child_process');
const { newId } = require('./store');
const { lastAssistant } = require('./transcript');
const { claudeCommandParts } = require('./claude-config');
const os = require('os');
const { claudeEnv, quoteCmd } = require('./shell');

const SUMMARY_PROMPT = [
  'Write a handoff summary of this conversation so another session can pick up the work.',
  'Cover: the goal, what was done, the current state (including anything unfinished or broken),',
  'the files touched, and the next steps. Be concise and use short bullet points under those headings.',
  'Reply with the summary only.',
].join(' ');

const TIMEOUT_MS = 180000;
const DRAFT_PROMPT_MAX = 1500;
const DRAFT_REPLY_MAX = 3000;

/** An auto name is stored as null so a reopened pane names itself after its folder again. */
function buildEntry(snap, { project = null, now = Date.now(), summarised = false } = {}) {
  const entry = {
    id: newId('a'),
    project,
    name: snap.autoName ? null : snap.name,
    cwd: snap.startCwd || snap.cwd,
    completedAt: now,
    summaryState: 'none',
  };
  if (!summarised) return entry;
  return {
    ...entry,
    summaryState: 'pending',
    branch: snap.branch || null,
    sessionId: snap.sessionId || null,
    openedAt: snap.openedAt || null,
    summary: null,
  };
}

const cap = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Fallback when Claude can't summarise: the first prompt and the last reply. */
function draftSummary(turns = [], lastReply = null) {
  const first = turns.find(t => t.role === 'user');
  const reply = lastReply || lastAssistant(turns);
  const parts = [];
  if (first) parts.push(`First prompt:\n${cap(first.text, DRAFT_PROMPT_MAX)}`);
  if (reply) parts.push(`Last reply:\n${cap(reply, DRAFT_REPLY_MAX)}`);
  return parts.join('\n\n') || 'No conversation was recorded.';
}

/**
 * Runs a headless, forked `claude -p` on the pane's session and resolves its reply.
 * The prompt is sent on stdin so no free text reaches a shell; Windows needs one to run `claude.cmd`.
 */
function summarise({ claudeCommand, sessionId, cwd, prompt, model, signal, env = claudeEnv(), spawn = childProcess.spawn, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    if (!/^[\w-]+$/.test(sessionId || '')) return reject(new Error('No session to summarise'));
    if (model && !/^[\w.:[\]-]+$/.test(model)) return reject(new Error(`Invalid model name: ${model}`));
    let [cmd, ...pre] = claudeCommandParts(claudeCommand);
    if (cmd.startsWith('~/')) cmd = os.homedir() + cmd.slice(1);
    const args = [...pre, '-p', '--resume', sessionId, '--fork-session', '--output-format', 'text'];
    if (model) args.push('--model', model);
    const opts = { cwd, env, signal };
    let child;
    try {
      child = process.platform === 'win32'
        ? spawn([cmd, ...args].map(quoteCmd).join(' '), [], { ...opts, shell: true, windowsHide: true })
        : spawn(cmd, args, opts);
    } catch (err) { return reject(err); }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(reject, new Error('Timed out summarising'));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => finish(reject, e));
    child.on('close', code => {
      const text = out.trim();
      if (code !== 0) return finish(reject, new Error(err.trim() || `claude exited with ${code}`));
      if (!text) return finish(reject, new Error('Claude returned an empty summary'));
      finish(resolve, text);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt || SUMMARY_PROMPT);
  });
}

/** What a pane reopened from the completed history is told about the earlier session. */
function contextPrompt(summary) {
  return `You are picking up work from a previous session. Summary:\n\n${summary.trim()}\n\nRead it, then wait for the user's instructions.\n`;
}

module.exports = { SUMMARY_PROMPT, buildEntry, draftSummary, summarise, contextPrompt };
