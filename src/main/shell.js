'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

function findOnPath(exe) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const p = path.join(d, exe);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

function defaultShell() {
  if (process.platform === 'win32') {
    return findOnPath('pwsh.exe') || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function shellFamily(shell) {
  const base = path.basename(shell).toLowerCase().replace(/\.exe$/, '');
  if (base === 'pwsh' || base === 'powershell') return 'pwsh';
  if (base === 'cmd') return 'cmd';
  if (base === 'fish') return 'fish';
  if (base === 'nu') return 'nu';
  if (base === 'bash') return 'bash';
  if (base === 'zsh') return 'zsh';
  return 'posix';
}

function quotePosix(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
function quotePwsh(s) {
  return `'${s.replace(/'/g, "''")}'`;
}
// Always-quoted form for a cmd.exe command line.
function quoteCmd(s) {
  return /^[\w@+=:,./\\-]+$/.test(s) ? s : `"${s}"`;
}

function prependPath(env, dir) {
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  env[key] = env[key] ? `${dir}${path.delimiter}${env[key]}` : dir;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

// How to spawn `shell` for a pane: returns { args, env } for pty.spawn.
// The pane's shim dir must win on PATH even if the user's rc files prepend their own dirs (e.g.
// ~/.local/bin, where the real claude often lives), so for each shell family we load the user's
// normal startup files first and only then prepend the shim dir. `startup` is an optional argv
// (e.g. ['claude', '-n', 'api']) run once at the interactive prompt; the shell stays open after it.
// On Windows the args are a single string: node-pty passes strings through verbatim, which avoids
// its argv escaping (it escapes " as \", which cmd.exe does not understand).
function buildLaunch({ shell, paneId, binDir, initDir, startup = null }) {
  const fam = shellFamily(shell);
  const env = ptyEnv(paneId);
  prependPath(env, binDir);
  const posixLine = startup ? startup.map(quotePosix).join(' ') : '';
  const exportPath = `export PATH=${quotePosix(binDir)}:"$PATH"`;

  switch (fam) {
    case 'bash': {
      const rc = path.join(initDir, 'bashrc');
      write(rc, ['[ -f ~/.bashrc ] && . ~/.bashrc', exportPath, posixLine, ''].join('\n'));
      return { args: ['--rcfile', rc, '-i'], env };
    }
    case 'zsh': {
      // zsh reads $ZDOTDIR/.zshenv then $ZDOTDIR/.zshrc: point ZDOTDIR at our dir, chain to the user's.
      env.ASTERISM_ORIG_ZDOTDIR = env.ZDOTDIR || '';
      env.ZDOTDIR = initDir;
      write(path.join(initDir, '.zshenv'), [
        'ZDOTDIR="${ASTERISM_ORIG_ZDOTDIR:-$HOME}"',
        '[ -f "$ZDOTDIR/.zshenv" ] && . "$ZDOTDIR/.zshenv"',
        'ASTERISM_USER_ZDOTDIR="$ZDOTDIR"',
        `ZDOTDIR=${quotePosix(initDir)}`,
        '',
      ].join('\n'));
      write(path.join(initDir, '.zshrc'), [
        'ZDOTDIR="$ASTERISM_USER_ZDOTDIR"',
        '[ -f "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"',
        '[ -z "$ASTERISM_ORIG_ZDOTDIR" ] && [ "$ZDOTDIR" = "$HOME" ] && unset ZDOTDIR',
        'unset ASTERISM_ORIG_ZDOTDIR ASTERISM_USER_ZDOTDIR',
        exportPath,
        posixLine,
        '',
      ].join('\n'));
      return { args: ['-i'], env };
    }
    case 'fish':
      // -C runs after the user's config.fish.
      return { args: ['-i', '-C', `set -gx PATH ${quotePosix(binDir)} $PATH; ${posixLine}`], env };
    case 'pwsh': {
      // -Command runs after the user's profile.
      const safe = (startup || []).map(a => a.replace(/"/g, "'"));
      const script = `$env:PATH = ${quotePwsh(binDir)} + [IO.Path]::PathSeparator + $env:PATH` +
        (startup ? `; & ${safe.map(quotePwsh).join(' ')}` : '');
      if (process.platform !== 'win32') return { args: ['-NoLogo', '-NoExit', '-Command', script], env };
      return { args: `-NoLogo -NoExit -Command "${script.replace(/"/g, '\\"')}"`, env };
    }
    case 'cmd': {
      // /k runs after the user's AutoRun.
      const init = path.join(initDir, 'init.cmd');
      const safe = (startup || []).map(a => a.replace(/"/g, "'"));
      write(init, ['@echo off', `set "PATH=${binDir};%PATH%"`, startup ? safe.map(quoteCmd).join(' ') : '', ''].join('\r\n'));
      return { args: `/s /k ""${init}""`, env };
    }
    case 'nu':
      return { args: startup ? ['-i', '-e', startup.map(a => JSON.stringify(a)).join(' ')] : ['-i'], env };
    default:
      // sh/dash/ksh: no rc hook we can rely on; the env PATH prepend above has to do.
      return { args: startup ? ['-i', '-c', `${posixLine}; exec ${quotePosix(shell)} -i`] : ['-i'], env };
  }
}

// Per-session markers a parent Claude Code process sets. Inheriting them makes the child think it is
// a nested/child session (e.g. it disables transcript saving), and some carry a parent's socket token.
const SESSION_MARKERS = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_DESKTOP',
];

// If Asterism was launched from inside Claude Code these would make claude think it is nested.
// Other CLAUDE_CODE_* vars (e.g. provider config) are the user's and are kept.
function claudeEnv() {
  const env = { ...process.env };
  for (const k of SESSION_MARKERS) delete env[k];
  return env;
}

function ptyEnv(paneId) {
  const env = claudeEnv();
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.ASTERISM_PANE_ID = paneId;
  return env;
}

const ENV_MARK = '__ASTERISM_ENV__';
const SHELL_PATH_TIMEOUT_MS = 5000;
const shellPaths = new Map();

/**
 * PATH as `shell` sets it up when it starts in a pane, with any entries of Asterism's own PATH it
 * lacks added after. A desktop launcher starts Asterism with a minimal PATH that often misses where
 * claude lives (e.g. ~/.local/bin), so commands run outside a pane need this to find it. Read once
 * per shell; falls back to Asterism's own PATH.
 */
function shellPath(shell) {
  const own = process.env.PATH || '';
  if (process.platform === 'win32') return Promise.resolve(own);
  if (!shellPaths.has(shell)) {
    shellPaths.set(shell, readShellPath(shell).then(p => mergePaths(p, own), () => own));
  }
  return shellPaths.get(shell);
}

function readShellPath(shell) {
  return new Promise((resolve, reject) => {
    let out = '';
    // Interactive and login, so both kinds of rc file run. `env` prints PATH colon-joined in every
    // shell (fish's "$PATH" would join with spaces), and the markers skip anything the rc files print.
    const child = spawn(shell, ['-ilc', `echo ${ENV_MARK}; env; echo ${ENV_MARK}`], {
      stdio: ['ignore', 'pipe', 'ignore'], env: claudeEnv(), timeout: SHELL_PATH_TIMEOUT_MS,
    });
    child.stdout.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', () => {
      const block = out.split(ENV_MARK)[1] || '';
      const line = block.split('\n').find(l => l.startsWith('PATH='));
      if (line) resolve(line.slice(5).trim()); else reject(new Error('No PATH from the shell'));
    });
  });
}

function mergePaths(first, rest) {
  const parts = [...first.split(path.delimiter), ...rest.split(path.delimiter)].filter(Boolean);
  return [...new Set(parts)].join(path.delimiter);
}

function homeDir() {
  return os.homedir();
}

module.exports = { defaultShell, shellFamily, buildLaunch, ptyEnv, claudeEnv, shellPath, homeDir, quotePosix, quotePwsh, quoteCmd };
