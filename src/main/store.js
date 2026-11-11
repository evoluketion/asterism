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
    theme: 'asterism',
    themeBg: '#0b0e12',  // lets the window open in the theme's colour before the page loads
  },
  // id -> { id, name, dir, layout }. The layout (panes, tree, preset) is saved as you work.
  projects: {},
  lastSession: null,
  recentDirs: [],
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

function newProjectId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'asterism-state.json');
    this.data = structuredClone(DEFAULTS);
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...loaded, settings: { ...DEFAULTS.settings, ...(loaded.settings || {}) } };
    } catch {}
    migrateWorkspaces(this.data);
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

module.exports = { Store, commonDir, newProjectId };
