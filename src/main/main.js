'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, Notification, clipboard, shell: eShell, Menu } = require('electron');
const { Store, newProjectId } = require('./store');
const { createServer } = require('./server');
const { PaneManager, isDir, sessionSaved } = require('./panes');
const archive = require('./archive');
const shell = require('./shell');
const { readTurns } = require('./transcript');
const { createToolHandler } = require('./mcp-tools');
const { detectVariant } = require('./variant');

/**
 * An issue-branch build is labelled with its issue number and keeps its own user data. Electron's
 * single-instance lock lives in that folder, so the build runs alongside the main one.
 */
const variant = process.env.ASTERISM_VARIANT ?? (app.isPackaged
  ? require(path.join(app.getAppPath(), 'package.json')).asterismVariant
  : detectVariant(app.getAppPath())) ?? null;
const APP_NAME = variant ? `Asterism #${variant}` : 'Asterism';

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(variant ? `dev.local.asterism.issue-${variant}` : 'dev.local.asterism');
if (process.env.ASTERISM_USER_DATA) app.setPath('userData', process.env.ASTERISM_USER_DATA);
else app.setPath('userData', path.join(app.getPath('appData'), variant ? `Asterism-issue-${variant}` : 'Asterism'));

const primary = process.env.ASTERISM_TEST || app.requestSingleInstanceLock();
if (!primary) app.quit();

// The app was called Alpha before it was renamed. Bring its settings and projects across once.
function importPreRenameState() {
  if (process.env.ASTERISM_USER_DATA || variant) return;
  const fs = require('fs');
  const dest = path.join(app.getPath('userData'), 'asterism-state.json');
  const old = path.join(app.getPath('appData'), 'Alpha', 'alpha-state.json');
  try {
    if (fs.existsSync(dest) || !fs.existsSync(old)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(old, dest);
  } catch {}
}

let win = null;
let store;
let manager;
let order = [];
const screenRequests = new Map();
let screenSeq = 0;

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function readScreen(paneId, lines) {
  return new Promise((resolve, reject) => {
    if (!win) return reject(new Error('No window'));
    const reqId = ++screenSeq;
    const timer = setTimeout(() => {
      screenRequests.delete(reqId);
      reject(new Error('Timed out reading the pane screen'));
    }, 2000);
    screenRequests.set(reqId, text => { clearTimeout(timer); resolve(text); });
    send('screen:request', reqId, paneId, lines);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: /^#[0-9a-f]{6}$/i.test(store.settings.themeBg || '') ? store.settings.themeBg : '#0b0e12',
    title: APP_NAME,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // No default menu: its accelerators (Ctrl+R reload, Ctrl+W close...) would destroy every pane.
  Menu.setApplicationMenu(null);
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) eShell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    if (input.key === 'F12') win.webContents.toggleDevTools();
    if (input.key === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
  });
  win.on('focus', () => win.flashFrame(false));
  win.on('close', e => {
    if (process.env.ASTERISM_TEST) return;
    const busy = manager.list().filter(p => ['working', 'permission', 'question'].includes(p.state));
    if (!busy.length) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Quit anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `${busy.length} pane${busy.length > 1 ? 's are' : ' is'} still working.`,
      detail: busy.map(p => `• ${p.name} (${p.state})`).join('\n') + '\n\nQuitting stops them. The layout and session IDs are saved so you can resume.',
    });
    if (choice === 1) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.ASTERISM_DEV) win.webContents.openDevTools({ mode: 'detach' });
}

// Only accept IPC from our own local page.
const trusted = e => !!(e.senderFrame && e.senderFrame.url.startsWith('file://'));
const handle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => { if (!trusted(e)) throw new Error('untrusted sender'); return fn(e, ...a); });
const listen = (ch, fn) => ipcMain.on(ch, (e, ...a) => { if (trusted(e)) fn(e, ...a); });

function registerIpc() {
  handle('app:init', () => ({
    settings: store.settings,
    projects: store.data.projects,
    lastSession: store.data.lastSession,
    recentDirs: store.data.recentDirs,
    archive: store.data.archive,
    defaults: { summaryPrompt: archive.SUMMARY_PROMPT },
    home: require('os').homedir(),
    platform: process.platform,
    version: app.getVersion(),
    appName: APP_NAME,
    test: !!process.env.ASTERISM_TEST,
  }));
  handle('pane:create', (_e, opts) => {
    // A pane reopened from the completed history is a fresh session given the summary, never a resume.
    const { context, ...rest } = opts || {};
    if (typeof context === 'string' && context.trim()) Object.assign(rest, { resume: null, appendSystemPrompt: archive.contextPrompt(context) });
    const snap = manager.create(rest);
    if (snap.kind === 'claude' || snap.kind === 'shell') store.addRecentDir(snap.cwd);
    return snap;
  });
  listen('pane:write', (_e, id, data) => manager.write(id, data));
  listen('pane:resize', (_e, id, cols, rows) => manager.resize(id, cols, rows));
  listen('pane:kill', (_e, id) => manager.kill(id));
  listen('pane:rename', (_e, id, name) => manager.rename(id, name));
  handle('pane:claude', (_e, id) => manager.relaunchClaude(id));
  handle('pane:diff', (_e, id) => manager.diff(id));
  listen('layout:order', (_e, ids) => { order = Array.isArray(ids) ? ids : []; });
  listen('app:waiting', (_e, count, title) => {
    if (!win) return;
    win.setTitle(title || APP_NAME);
    if (count > 0 && !win.isFocused()) win.flashFrame(true);
    if (count === 0) win.flashFrame(false);
  });
  listen('app:notify', (_e, paneId, title, body) => {
    if (!Notification.isSupported() || (win && win.isFocused())) return;
    const n = new Notification({ title, body, silent: true });
    n.on('click', () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      send('pane:focus', paneId);
    });
    n.show();
  });
  handle('dialog:dir', async (_e, start) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: start || undefined });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('settings:save', (_e, patch) => store.setSettings(patch || {}));
  // Create or edit a project (name, folder). Its layout is only ever written by session:save.
  handle('project:save', (_e, p) => {
    if (!p || typeof p.name !== 'string' || typeof p.dir !== 'string') return store.data.projects;
    const id = p.id && store.data.projects[p.id] ? p.id : newProjectId();
    const prev = store.data.projects[id] || {};
    const layout = p.layout !== undefined ? p.layout : (prev.layout || null);
    store.update({ projects: { ...store.data.projects, [id]: { id, name: p.name.trim(), dir: p.dir.trim(), layout } } });
    store.saveNow();
    return { projects: store.data.projects, id };
  });
  handle('project:delete', (_e, id) => {
    const next = { ...store.data.projects };
    delete next[id];
    store.update({ projects: next });
    store.dropArchivedForProject(id);
    return next;
  });
  // The open panes, saved as you work: as the last session, and into the active project if there is one.
  listen('session:save', (_e, ws, projectId) => {
    const patch = { lastSession: ws ? { ...ws, project: projectId || null } : null };
    const proj = projectId && store.data.projects[projectId];
    if (proj) patch.projects = { ...store.data.projects, [projectId]: { ...proj, layout: ws } };
    store.update(patch);
    store.saveNow();
  });
  handle('archive:complete', (_e, id, projectId) => completePane(id, projectId || null));
  handle('archive:remove', (_e, entryId) => store.removeArchived(entryId));
  handle('clipboard:read', () => clipboard.readText());
  listen('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  listen('open:external', (_e, url) => { if (/^https?:\/\//.test(url)) eShell.openExternal(url); });
  // The folder comes from the pane itself, so the renderer can only open folders panes are in.
  listen('open:dir', async (_e, id) => {
    const pane = manager.get(id);
    if (!pane) return;
    const dir = pane.status.claudeCwd || pane.cwd;
    if (!isDir(dir)) return;
    const err = await eShell.openPath(dir);
    if (err) console.error(`open folder ${dir}: ${err}`);
  });
  listen('screen:reply', (_e, reqId, text) => {
    const cb = screenRequests.get(reqId);
    if (cb) { screenRequests.delete(reqId); cb(String(text)); }
  });
}

// Records a pane in the completed history. The summary, when there is one, is filled in after
// this returns so the pane can close straight away.
function completePane(id, projectId) {
  const pane = manager.get(id);
  if (!pane) return { list: store.data.archive, summarised: false, reason: 'The pane is already closed.' };
  const snap = manager.snapshot(pane);
  const transcriptPath = pane.status.transcriptPath;
  const settings = store.settings;
  const summarised = !!settings.archiveCompleted && sessionSaved(snap.sessionId);
  const reason = settings.archiveCompleted && !summarised ? 'Nothing to summarise: the conversation was never saved.' : null;
  const entry = archive.buildEntry(snap, { project: projectId, summarised });
  const list = store.addArchived(entry);
  if (!summarised) return { list, summarised, reason };
  runSummary(entry, { transcriptPath, lastReply: snap.lastReply });
  return { list, summarised };
}

const summaryRuns = new Set();

// Fills in a pending entry's summary, falling back to a draft from the transcript. A run stopped by
// quitting leaves the entry pending, and it is summarised again at the next start.
async function runSummary(entry, { transcriptPath = null, lastReply = null } = {}) {
  const settings = store.settings;
  const ctrl = new AbortController();
  summaryRuns.add(ctrl);
  const env = { ...shell.claudeEnv(), PATH: await shell.shellPath(settings.shell || shell.defaultShell()) };
  archive.summarise({
    env,
    claudeCommand: settings.claudeCommand,
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    prompt: settings.summaryPrompt,
    model: settings.summaryModel,
    signal: ctrl.signal,
  }).then(
    summary => ({ summaryState: 'done', summary }),
    async () => (ctrl.signal.aborted ? null : { summaryState: 'fallback', summary: archive.draftSummary(await readTurns(transcriptPath), lastReply) }),
  ).then(patch => {
    if (patch) send('archive:changed', store.updateArchived(entry.id, patch));
  }).catch(err => console.error('Could not save the summary:', err))
    .finally(() => summaryRuns.delete(ctrl));
}

app.whenReady().then(async () => {
  if (!primary) return;
  importPreRenameState();
  store = new Store(app.getPath('userData'));
  const runtimeDir = path.join(app.getPath('userData'), 'runtime');

  let toolHandler;
  const server = createServer({
    hook: (paneId, event, body) => manager.hook(paneId, event, body),
    get tools() { return toolHandler.tools; },
    callTool: (paneId, name, args) => toolHandler.callTool(paneId, name, args),
  });
  await server.listen();
  // Runtime files (hook settings, shims) from a previous run are stale: their port and tokens are dead.
  require('./claude-config').cleanupAll(runtimeDir);

  manager = new PaneManager({ runtimeDir, server, getSettings: () => store.settings });
  toolHandler = createToolHandler({ manager, getOrder: () => order, readScreen });
  manager.on('data', (id, data) => send('pane:data', id, data));
  manager.on('status', (id, snap) => send('pane:status', id, snap));
  manager.on('exit', (id, code) => send('pane:exit', id, code));

  registerIpc();
  createWindow();
  for (const e of store.data.archive) if (e.summaryState === 'pending') runSummary(e);

  if (process.env.ASTERISM_TEST) {
    require('./selftest').run({ app, win, manager, server, store, send, readScreen });
  }
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => { if (store) { try { store.saveNow(); } catch {} } });

app.on('before-quit', () => {
  for (const ctrl of summaryRuns) ctrl.abort();
  if (store) { try { store.saveNow(); } catch {} }
  if (manager) manager.killAll();
});
