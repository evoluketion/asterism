'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  settings: {
    claudeCommand: 'claude',
    shell: '',
    notifyDesktop: true,
    sound: true,
    fontSize: 13,
    fontFamily: '',
    toolbarHidden: false,
    reopenLast: false,   // reopen the last project (or loose panes) with conversations resumed at startup
    backgroundQuietMin: 10, // background work with no hook events this long counts as done; 0 = never
    theme: 'asterism',
    themeBg: '#0b0e12',  // lets the window open in the theme's colour before the page loads
    archiveCompleted: false,
    summaryPrompt: '',   // empty: the built-in prompt
    summaryModel: '',    // empty: Claude's own default model
  },
  // id -> { id, name, dir, layout }. The layout (panes, tree, preset) is saved as you work.
  projects: {},
  lastSession: null,
  recentDirs: [],
  // Completed panes, newest first. Kept apart from projects because project:save rebuilds them.
  archive: [],
};

// Most common folder among a layout's panes: the natural home folder for a project made from it.
function commonDir(layout) {
  const counts = new Map();
  for (const p of (layout && layout.panes) || []) if (p.cwd) counts.set(p.cwd, (counts.get(p.cwd) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

// Saved workspaces from earlier versions become projects.
function migrateWorkspaces(data) {
  const old = data.workspaces;
  delete data.workspaces;
  delete data.settings.defaultCwd;
  delete data.settings.setupDone;
  if (!old || typeof old !== 'object') return;
  for (const [name, layout] of Object.entries(old)) {
    if (Object.values(data.projects).some(p => p.name === name)) continue;
    const id = newProjectId();
    data.projects[id] = { id, name, dir: commonDir(layout), layout };
  }
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const newProjectId = () => newId('p');

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'asterism-state.json');
    this.data = structuredClone(DEFAULTS);
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...loaded, settings: { ...DEFAULTS.settings, ...(loaded.settings || {}) } };
    } catch {}
    migrateWorkspaces(this.data);
    if (!Array.isArray(this.data.archive)) this.data.archive = [];
    this.saveTimer = null;
  }

  get settings() { return this.data.settings; }

  update(patch) {
    Object.assign(this.data, patch);
    this.scheduleSave();
  }

  setSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.scheduleSave();
    return this.data.settings;
  }

  addRecentDir(dir) {
    if (!dir) return;
    this.data.recentDirs = [dir, ...this.data.recentDirs.filter(d => d !== dir)].slice(0, 12);
    this.scheduleSave();
  }

  setArchive(list) {
    this.data.archive = list;
    this.saveNow();
    return list;
  }

  addArchived(entry) { return this.setArchive([entry, ...this.data.archive]); }
  updateArchived(id, patch) { return this.setArchive(this.data.archive.map(e => (e.id === id ? { ...e, ...patch } : e))); }
  removeArchived(id) { return this.setArchive(this.data.archive.filter(e => e.id !== id)); }
  dropArchivedForProject(projectId) { return this.setArchive(this.data.archive.filter(e => e.project !== projectId)); }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, commonDir, newId, newProjectId };
