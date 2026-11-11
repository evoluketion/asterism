'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { PaneStatus } = require('./status');
const claudeConfig = require('./claude-config');
const shell = require('./shell');
const git = require('./git');

// Electron's fs treats paths inside app.asar as folders, but the shell can't chdir into them.
const realFs = (() => { try { return require('original-fs'); } catch { return fs; } })();

const FLUSH_MS = 4;
const TICK_MS = 500;
const REPLY_MAX = 4000;
const START_FALLBACK_MS = 1500;

class PaneManager extends EventEmitter {
  constructor({ runtimeDir, server, getSettings }) {
    super();
    this.runtimeDir = runtimeDir;
    this.server = server;
    this.getSettings = getSettings;
    this.panes = new Map();
    this.seq = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  // The process is spawned on the first resize from the renderer, so it starts at the pane's real
  // size: an early resize makes ConPTY repaint Claude's TUI and duplicate lines.
  create({ kind = 'claude', name, cwd, args = [], resume = null }) {
    const id = `p${++this.seq}`;
    if (!cwd || !isDir(cwd)) cwd = shell.homeDir();
    if (resume && !sessionSaved(resume)) resume = null;
    const pane = {
      id, kind, cwd, proc: null, resume,
      name: name || defaultName(cwd, kind),
      autoName: !name,
      args, branch: null,
      status: new PaneStatus(kind),
      buf: '', flushTimer: null, alive: true, startTimer: null, earlyInput: '',
    };
    this.panes.set(id, pane);
    pane.startTimer = setTimeout(() => this.start(pane, 120, 30), START_FALLBACK_MS);
    this.refreshBranch(pane);
    return this.snapshot(pane);
  }

  start(pane, cols, rows) {
    clearTimeout(pane.startTimer);
    if (pane.proc || !pane.alive) return;
    const settings = this.getSettings();
    const sh = settings.shell || shell.defaultShell();
    let proc;
    try {
      const { binDir, initDir } = claudeConfig.preparePane({
        runtimeDir: this.runtimeDir, port: this.server.port, token: this.server.tokenFor(pane.id),
        paneId: pane.id, claudeCommand: settings.claudeCommand,
      });
      let startup = null;
      if (pane.kind === 'claude') {
        startup = ['claude'];
        if (pane.name) startup.push('-n', pane.name);
        if (pane.resume) startup.push('--resume', pane.resume);
        startup.push(...pane.args);
      }
      const { args, env } = shell.buildLaunch({ shell: sh, paneId: pane.id, binDir, initDir, startup });
      const opts = { name: 'xterm-256color', cols, rows, cwd: pane.cwd, env };
      if (process.platform === 'win32') opts.useConptyDll = true;
      proc = pty.spawn(sh, args, opts);
    } catch (err) {
      pane.alive = false;
      pane.status.onExit();
      this.emitStatus(pane);
      this.emit('data', pane.id, `\x1b[31mCould not start "${sh}": ${err.message}\x1b[0m\r\nCheck the shell setting (⚙).\r\n`);
      this.emit('exit', pane.id, -1);
      return;
    }
    pane.proc = proc;
    if (pane.earlyInput) { proc.write(pane.earlyInput); pane.earlyInput = ''; }
    proc.onData(data => {
      pane.status.onOutput();
      pane.buf += data;
      if (!pane.flushTimer) {
        pane.flushTimer = setTimeout(() => {
          pane.flushTimer = null;
          const out = pane.buf;
          pane.buf = '';
          if (this.panes.has(pane.id)) this.emit('data', pane.id, out);
        }, FLUSH_MS);
      }
    });
    proc.onExit(({ exitCode }) => {
      pane.alive = false;
      if (!this.panes.has(pane.id)) return;
      if (pane.status.onExit()) this.emitStatus(pane);
      this.emit('exit', pane.id, exitCode);
    });
  }

  get(id) { return this.panes.get(id); }

  write(id, data) {
    const pane = this.panes.get(id);
    if (!pane || !pane.alive) return;
    if (!pane.proc) { pane.earlyInput += data; return; } // typed before the shell started
    if (pane.status.onInput(data)) this.emitStatus(pane);
    pane.proc.write(data);
  }

  resize(id, cols, rows) {
    const pane = this.panes.get(id);
    if (!pane || !pane.alive || !(cols > 1 && rows > 1)) return;
    if (!pane.proc) return this.start(pane, cols, rows);
    try { pane.proc.resize(cols, rows); } catch {}
  }

  // Start claude again in a pane whose shell is still alive (after /exit), resuming the last session.
  relaunchClaude(id) {
    const pane = this.panes.get(id);
    if (!pane || !pane.alive || !pane.proc) return false;
    const sh = this.getSettings().shell || shell.defaultShell();
    const fam = shell.shellFamily(sh);
    const sid = sessionSaved(pane.status.sessionId) ? pane.status.sessionId : null;
    const clear = fam === 'pwsh' ? '\x1b' : fam === 'cmd' ? '' : '\x15'; // discard any half-typed line
    const resume = sid ? ` --resume ${fam === 'pwsh' ? shell.quotePwsh(sid) : sid}` : '';
    pane.proc.write(`${clear}claude${resume}\r`);
    return true;
  }

  rename(id, name) {
    const pane = this.panes.get(id);
    if (!pane || !name) return;
    pane.autoName = false;
    pane.name = String(name).slice(0, 60);
    this.emitStatus(pane);
  }

  kill(id) {
    const pane = this.panes.get(id);
    if (!pane) return;
    this.panes.delete(id);
    clearTimeout(pane.flushTimer);
    clearTimeout(pane.startTimer);
    pane.alive = false;
    if (pane.proc) { try { pane.proc.kill(); } catch {} }
    claudeConfig.cleanup(this.runtimeDir, id);
  }

  killAll() {
    clearInterval(this.timer);
    for (const id of [...this.panes.keys()]) this.kill(id);
  }

  hook(id, event, body) {
    const pane = this.panes.get(id);
    if (!pane) return;
    const changed = pane.status.applyHook(event, body);
    // A pane with a default name follows the folder its current Claude session started in
    // (e.g. after `cd ~/code/api && claude`).
    if (pane.autoName && event === 'SessionStart' && body.cwd && body.source !== 'compact') {
      const next = defaultName(body.cwd, 'claude');
      if (next !== pane.name) { pane.name = next; this.emitStatus(pane); }
    }
    if (event === 'Stop' || event === 'SessionStart') this.refreshBranch(pane);
    if (changed) this.emitStatus(pane);
    this.emit('hook', id, event, pane.status.state);
  }

  tick() {
    for (const pane of this.panes.values()) {
      if (pane.status.tick()) this.emitStatus(pane);
    }
  }

  async refreshBranch(pane) {
    const branch = await git.branchOf(pane.status.claudeCwd || pane.cwd);
    if (branch !== pane.branch) {
      pane.branch = branch;
      if (this.panes.has(pane.id)) this.emitStatus(pane);
    }
  }

  emitStatus(pane) {
    this.emit('status', pane.id, this.snapshot(pane));
  }

  snapshot(pane) {
    const s = pane.status.toJSON();
    if (s.lastReply && s.lastReply.length > REPLY_MAX) s.lastReply = s.lastReply.slice(0, REPLY_MAX) + '…';
    return { id: pane.id, name: pane.name, kind: pane.kind, cwd: s.claudeCwd || pane.cwd, branch: pane.branch, alive: pane.alive, args: pane.args, ...s };
  }

  list() {
    return [...this.panes.values()].map(p => this.snapshot(p));
  }
}

// Claude gives a session an ID at startup but only writes its transcript after the first message,
// so resuming a pane nobody typed in fails with "No conversation found". Transcripts live at
// <config>/projects/<folder>/<id>.jsonl. If that folder can't be read, assume the session exists.
function sessionSaved(id) {
  if (!id || !/^[\w-]+$/.test(id)) return false;
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return true; }
  return dirs.some(d => fs.existsSync(path.join(root, d, `${id}.jsonl`)));
}

function isDir(p) {
  try { return realFs.statSync(p).isDirectory(); } catch { return false; }
}

function defaultName(cwd, kind) {
  const base = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
  return kind === 'shell' ? `${base} (shell)` : base;
}

module.exports = { PaneManager, sessionSaved };
