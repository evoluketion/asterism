import { Terminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { WebglAddon } from '../../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs';
import { WebLinksAddon } from '../../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs';
import { SearchAddon } from '../../node_modules/@xterm/addon-search/lib/addon-search.mjs';
import * as L from './layout.js';
import { THEMES, getTheme, cssVars, termTheme } from './themes.js';

const api = window.asterism;
const $ = sel => document.querySelector(sel);

const DEFAULT_FONT = '"JetBrains Mono", "Cascadia Mono", "Fira Code", "DejaVu Sans Mono", Consolas, "Liberation Mono", monospace';
const STATE_LABEL = {
  starting: 'Starting', idle: 'Idle', working: 'Working', ready: 'Ready', permission: 'Needs permission',
  question: 'Question', error: 'Error', shell: 'Shell', exited: 'Exited', check: 'Check pane',
};
const NEEDS_YOU = new Set(['ready', 'permission', 'question', 'error', 'check']);
const URGENT = new Set(['permission', 'question', 'error', 'check']);
const HOOK_WARN_MS = 15000;

const S = {
  panes: new Map(),     // id -> pane view
  pending: new Map(),   // id -> data that arrived before the view existed
  dead: new Set(),      // ids of closed panes; late output for them is dropped
  custom: false,        // user resized/restored a non-preset tree: add/remove panes in place
  tree: null,
  preset: 'grid',
  focused: null,
  zoomed: null,
  settings: {},
  projects: {},         // id -> { id, name, dir, layout }
  project: null,        // id of the active project, or null
  lastSession: null,
  recentDirs: [],
  home: '',
  restoring: false,
  onModalDismiss: null, // undo a live preview when a modal is dismissed
};

// ---------- Panes ----------

async function newPane(opts = {}) {
  let snap;
  try {
    snap = await api.createPane(opts);
  } catch (err) {
    toast(`Could not open pane: ${err.message || err}`);
    return null;
  }
  const view = createView(snap);
  S.panes.set(snap.id, view);
  const early = S.pending.get(snap.id);
  if (early) { view.term.write(early); S.pending.delete(snap.id); }
  if (opts.replace) {
    S.tree = L.swapPanes(S.tree, opts.replace, snap.id);
    disposeView(opts.replace);
  } else if (!S.restoring) {
    S.tree = S.custom && S.tree ? splitBeside(S.focused, snap.id) : L.buildPreset(S.preset, [...L.leafIds(S.tree), snap.id]);
  }
  if (!S.restoring) {
    renderLayout();
    focusPane(snap.id);
  }
  return snap.id;
}

// In a customised layout, split the focused pane along its longer side.
function splitBeside(targetId, newId) {
  const ids = L.leafIds(S.tree);
  const target = ids.includes(targetId) ? targetId : ids[ids.length - 1];
  const el = S.panes.get(target)?.el;
  const wide = !el || el.offsetWidth >= el.offsetHeight * 1.2;
  return L.splitPane(S.tree, target, newId, wide ? 'row' : 'col');
}

function createView(snap) {
  const el = document.createElement('div');
  el.className = 'pane';
  el.dataset.id = snap.id;
  el.innerHTML = `
    <div class="pane-bar" draggable="true">
      <span class="pane-num"></span>
      <span class="pane-name"></span>
      <span class="pane-meta"></span>
      <span class="pane-reply"></span>
      <span class="pane-chip"></span>
      <button class="pane-btn restart hidden" title="Start Claude again, resuming this conversation">↻ Claude</button>
      <button class="pane-btn zoom" title="Zoom (Ctrl+Shift+Enter)">⤢</button>
      <button class="pane-btn close" title="Close (Ctrl+Shift+W)">✕</button>
    </div>
    <div class="pane-term"></div>
    <div class="pane-search hidden"><input placeholder="Find in scrollback  (Enter / Shift+Enter, Esc)" spellcheck="false"><span class="pane-search-count"></span></div>`;
  const bar = el.querySelector('.pane-bar');
  const termEl = el.querySelector('.pane-term');

  const term = new Terminal({
    fontFamily: S.settings.fontFamily || DEFAULT_FONT,
    fontSize: S.settings.fontSize || 13,
    lineHeight: 1.1,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    rescaleOverlappingGlyphs: true,
    linkHandler: { activate: (_e, uri) => api.openExternal(uri), allowNonHttpProtocols: false },
    theme: termTheme(getTheme(S.settings.theme)),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, uri) => api.openExternal(uri)));

  const view = {
    id: snap.id, el, bar, termEl, term, fit, search, status: snap, opened: false, exited: false, restarting: false,
    launch: { kind: snap.kind, name: snap.name, cwd: snap.cwd, args: snap.args || [] },
    lastCols: 0, lastRows: 0,
  };

  term.onData(data => {
    if (view.exited) {
      if (data.includes('\r')) restartPane(view.id);
      return;
    }
    api.write(view.id, data);
  });
  term.attachCustomKeyEventHandler(ev => {
    // Shift+Enter → ESC CR, which Claude Code treats as "insert newline".
    if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      if (ev.type === 'keydown') api.write(view.id, '\x1b\r');
      return false;
    }
    return true;
  });
  termEl.addEventListener('contextmenu', async e => {
    e.preventDefault();
    if (term.hasSelection()) { api.clipboardWrite(term.getSelection()); term.clearSelection(); }
    else { const t = await api.clipboardRead(); if (t) term.paste(t); }
  });
  el.addEventListener('mousedown', () => setFocused(view.id), true);

  new ResizeObserver(() => scheduleFit(view)).observe(termEl);

  bar.querySelector('.restart').addEventListener('click', e => { e.stopPropagation(); restartPane(view.id); });
  wireSearch(view);
  bar.querySelector('.close').addEventListener('click', e => { e.stopPropagation(); closePane(view.id); });
  bar.querySelector('.zoom').addEventListener('click', e => { e.stopPropagation(); toggleZoom(view.id); });
  bar.addEventListener('dblclick', e => {
    if (e.target.classList.contains('pane-name')) renamePrompt(view.id);
    else if (!e.target.closest('button')) toggleZoom(view.id);
  });
  bar.addEventListener('dragstart', e => { e.dataTransfer.setData('text/asterism-pane', view.id); e.dataTransfer.effectAllowed = 'move'; });
  bar.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/asterism-pane')) return;
    e.preventDefault(); bar.classList.add('drop-target');
  });
  bar.addEventListener('dragleave', () => bar.classList.remove('drop-target'));
  bar.addEventListener('drop', e => {
    bar.classList.remove('drop-target');
    const from = e.dataTransfer.getData('text/asterism-pane');
    if (from && from !== view.id) { e.preventDefault(); S.tree = L.swapPanes(S.tree, from, view.id); renderLayout(); }
  });

  updateBar(view);
  return view;
}

function openTerm(view) {
  if (view.opened) return;
  view.term.open(view.termEl);
  view.opened = true;
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    view.term.loadAddon(gl);
  } catch { /* canvas/DOM renderer fallback */ }
}

function scheduleFit(view) {
  if (view.fitPending) return;
  view.fitPending = true;
  requestAnimationFrame(() => {
    view.fitPending = false;
    if (!view.opened || !view.termEl.offsetWidth || !view.termEl.offsetHeight) return;
    try { view.fit.fit(); } catch { return; }
    const { cols, rows } = view.term;
    if (cols !== view.lastCols || rows !== view.lastRows) {
      view.lastCols = cols; view.lastRows = rows;
      api.resize(view.id, cols, rows);
    }
  });
}

function disposeView(id) {
  const view = S.panes.get(id);
  if (!view) return;
  S.panes.delete(id);
  S.dead.add(id);
  S.pending.delete(id);
  api.kill(id);
  view.term.dispose();
  view.el.remove();
}

function closePane(id, { force = false } = {}) {
  const view = S.panes.get(id);
  if (!view) return;
  const st = view.status.state;
  if (!force && ['working', 'permission', 'question'].includes(st) &&
      !confirm(`"${view.status.name}" is ${STATE_LABEL[st].toLowerCase()}. Close it anyway?`)) return;
  const order = L.leafIds(S.tree);
  const idx = order.indexOf(id);
  disposeView(id);
  S.tree = L.removePane(S.tree, id);
  if (S.zoomed === id) S.zoomed = null;
  if (!S.custom) S.tree = L.buildPreset(S.preset, L.leafIds(S.tree));
  renderLayout();
  const rest = L.leafIds(S.tree);
  if (rest.length) focusPane(rest[Math.min(idx, rest.length - 1)]);
  else S.focused = null;
}

async function restartPane(id) {
  const view = S.panes.get(id);
  if (!view || view.restarting) return;
  const s = view.status;
  // Shell still alive (Claude was /exit-ed): just run claude in it again.
  if (!view.exited && s.kind === 'claude') { await api.relaunchClaude(id); view.term.focus(); return; }
  view.restarting = true;
  const kind = s.kind;
  const cwd = kind === 'claude' ? (s.startCwd || view.launch.cwd) : view.launch.cwd;
  const resume = kind === 'claude' ? s.sessionId : null;
  const args = kind === view.launch.kind ? view.launch.args : [];
  const created = await newPane({ kind, name: s.name, cwd, args, resume, replace: id });
  if (!created) view.restarting = false;
}

function renamePrompt(id) {
  const view = S.panes.get(id);
  if (!view) return;
  const r = view.bar.querySelector('.pane-name').getBoundingClientRect();
  showPopover(r.left, r.bottom + 4, pop => {
    pop.innerHTML = `<h3>Rename pane</h3><input id="rn" value="${esc(view.status.name)}"><div class="actions"><button id="rn-ok" class="primary">Rename</button></div>`;
    const input = pop.querySelector('#rn');
    const ok = () => { api.rename(id, input.value.trim()); hidePopover(); focusPane(id); };
    pop.querySelector('#rn-ok').onclick = ok;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    input.select();
  });
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

const SEARCH_OPTS = {
  decorations: {
    matchBackground: '#5a4500', activeMatchBackground: '#b07d00',
    matchOverviewRuler: '#b07d00', activeMatchColorOverviewRuler: '#ffb224',
  },
};

function wireSearch(view) {
  const box = view.el.querySelector('.pane-search');
  const input = box.querySelector('input');
  const count = box.querySelector('.pane-search-count');
  view.search.onDidChangeResults(({ resultIndex, resultCount }) => {
    count.textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : (input.value ? 'no matches' : '');
  });
  input.addEventListener('input', () => view.search.findNext(input.value, { ...SEARCH_OPTS, incremental: true }));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); (e.shiftKey ? view.search.findPrevious : view.search.findNext).call(view.search, input.value, SEARCH_OPTS); }
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(view); }
    e.stopPropagation();
  });
}

function openSearch(view) {
  const box = view.el.querySelector('.pane-search');
  box.classList.remove('hidden');
  const input = box.querySelector('input');
  if (view.term.hasSelection()) input.value = view.term.getSelection().split('\n')[0];
  input.focus();
  input.select();
}

function closeSearch(view) {
  view.el.querySelector('.pane-search').classList.add('hidden');
  view.search.clearDecorations();
  view.term.focus();
}

// ---------- Layout rendering ----------

function renderLayout() {
  const grid = $('#grid');
  const ids = L.leafIds(S.tree);
  const tree = S.zoomed && ids.includes(S.zoomed) ? { type: 'pane', id: S.zoomed } : S.tree;
  if (!S.zoomed || !ids.includes(S.zoomed)) S.zoomed = null;

  // Detach pane elements so they survive the rebuild.
  for (const v of S.panes.values()) v.el.remove();
  grid.replaceChildren();
  if (tree) grid.appendChild(buildNode(tree, []));
  for (const v of S.panes.values()) {
    if (v.el.isConnected) { openTerm(v); scheduleFit(v); }
  }

  $('#empty').classList.toggle('hidden', ids.length > 0);
  if (!ids.length) renderEmpty();
  ids.forEach((id, i) => {
    const v = S.panes.get(id);
    if (v) v.bar.querySelector('.pane-num').textContent = String(i + 1);
  });
  for (const b of document.querySelectorAll('#layouts button')) b.classList.toggle('active', b.dataset.preset === S.preset);
  api.setOrder(ids);
  updateWaiting();
  scheduleSessionSave();
}

function buildNode(node, path) {
  if (node.type === 'pane') {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.style.flex = '1 1 0';
    const v = S.panes.get(node.id);
    if (v) cell.appendChild(v.el);
    return cell;
  }
  const wrap = document.createElement('div');
  wrap.className = `split ${node.dir}`;
  node.children.forEach((child, i) => {
    const el = buildNode(child, [...path, i]);
    el.style.flex = `${node.sizes[i]} 1 0`;
    wrap.appendChild(el);
    if (i < node.children.length - 1) wrap.appendChild(makeDivider(node, path, i, wrap));
  });
  return wrap;
}

function makeDivider(node, path, i, wrap) {
  const d = document.createElement('div');
  d.className = 'divider';
  d.addEventListener('pointerdown', e => {
    e.preventDefault();
    d.setPointerCapture(e.pointerId);
    d.classList.add('dragging');
    document.body.classList.add('resizing');
    const horiz = node.dir === 'row';
    const kids = [...wrap.children].filter(c => !c.classList.contains('divider'));
    const a = kids[i].getBoundingClientRect();
    const b = kids[i + 1].getBoundingClientRect();
    const start = horiz ? e.clientX : e.clientY;
    const total = horiz ? a.width + b.width : a.height + b.height;
    const pairFrac = node.sizes[i] + node.sizes[i + 1];
    const aStart = horiz ? a.width : a.height;
    const minPx = 120;
    let sizes = node.sizes;
    const move = ev => {
      const delta = (horiz ? ev.clientX : ev.clientY) - start;
      const aPx = Math.min(Math.max(aStart + delta, minPx), total - minPx);
      sizes = [...node.sizes];
      sizes[i] = pairFrac * (aPx / total);
      sizes[i + 1] = pairFrac - sizes[i];
      kids[i].style.flex = `${sizes[i]} 1 0`;
      kids[i + 1].style.flex = `${sizes[i + 1]} 1 0`;
    };
    const up = () => {
      d.removeEventListener('pointermove', move);
      d.removeEventListener('pointerup', up);
      d.classList.remove('dragging');
      document.body.classList.remove('resizing');
      S.tree = L.setSizesAt(S.tree, path, sizes);
      S.custom = true;
      renderLayout();
    };
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', up);
  });
  d.addEventListener('dblclick', () => {
    const sizes = [...node.sizes];
    const pair = sizes[i] + sizes[i + 1];
    sizes[i] = sizes[i + 1] = pair / 2;
    S.tree = L.setSizesAt(S.tree, path, sizes);
    S.custom = true;
    renderLayout();
  });
  return d;
}

function setPreset(preset) {
  S.preset = preset;
  S.custom = false;
  S.zoomed = null;
  S.tree = L.buildPreset(preset, L.leafIds(S.tree));
  renderLayout();
  if (S.focused) focusPane(S.focused);
}

function toggleZoom(id = S.focused) {
  if (!id) return;
  S.zoomed = S.zoomed === id ? null : id;
  renderLayout();
  focusPane(id);
}

// ---------- Focus & status ----------

function setFocused(id) {
  if (S.focused === id) return;
  S.focused = id;
  for (const v of S.panes.values()) v.el.classList.toggle('focused', v.id === id);
}

function focusPane(id) {
  const v = S.panes.get(id);
  if (!v) return;
  if (S.zoomed && S.zoomed !== id) { S.zoomed = id; renderLayout(); }
  setFocused(id);
  v.term.focus();
}

function jumpToWaiting() {
  const statuses = Object.fromEntries([...S.panes.values()].map(v => [v.id, { state: effectiveState(v), needsYou: needsYou(v), since: v.status.since }]));
  const order = L.waitingOrder(statuses);
  if (!order.length) return;
  // Cycle: if already on the first waiting pane, go to the next one.
  const next = order[0] === S.focused && order.length > 1 ? order[1] : order[0];
  focusPane(next);
}

function moveFocus(dir) {
  if (!S.focused || S.zoomed) return;
  const rects = {};
  for (const v of S.panes.values()) {
    if (!v.el.isConnected) continue;
    const r = v.el.getBoundingClientRect();
    rects[v.id] = { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  const n = L.findNeighbor(rects, S.focused, dir);
  if (n) focusPane(n);
}

function shortPath(p) {
  if (!p) return '';
  if (S.home && (p === S.home || p.startsWith(S.home + '/') || p.startsWith(S.home + '\\'))) return '~' + p.slice(S.home.length);
  return p;
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

function oneLine(text, n = 200) {
  if (!text) return '';
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// What the pane shows: the hook-driven state, plus renderer-only 'exited' and 'check'
// (a Claude pane that has sent no hook for a while, e.g. sitting on the folder-trust prompt).
function effectiveState(view) {
  const s = view.status;
  if (view.exited) return 'exited';
  if (s.kind === 'claude' && s.state === 'starting' && !s.hooksSeen && Date.now() - s.since > HOOK_WARN_MS) return 'check';
  return s.state;
}
const needsYou = view => NEEDS_YOU.has(effectiveState(view));

function updateBar(view) {
  const s = view.status;
  const state = effectiveState(view);
  view.el.dataset.state = state;
  view.bar.querySelector('.pane-name').textContent = s.name;
  view.bar.querySelector('.pane-name').title = `${s.name} — double-click to rename`;
  const meta = [shortPath(s.cwd), s.branch ? `⎇ ${s.branch}` : ''].filter(Boolean).join('  ');
  const metaEl = view.bar.querySelector('.pane-meta');
  metaEl.textContent = meta;
  metaEl.title = s.cwd || '';

  const replyEl = view.bar.querySelector('.pane-reply');
  let reply = '';
  let tip = '';
  if (state === 'working') {
    reply = s.currentTool ? `${s.currentTool} · ${oneLine(s.lastPrompt, 120)}` : `▸ ${oneLine(s.lastPrompt, 160)}`;
    tip = s.lastPrompt || '';
  } else if (state === 'error') {
    reply = oneLine(s.error, 200);
    tip = s.error || '';
  } else if (s.lastReply) {
    reply = oneLine(s.lastReply);
    tip = s.lastReply;
  }
  replyEl.textContent = reply;
  replyEl.title = tip.slice(0, 2000);

  const chip = view.bar.querySelector('.pane-chip');
  const now = Date.now();
  let label = STATE_LABEL[state] || state;
  if (state === 'check') {
    chip.title = 'No Claude Code hook events have arrived yet. Claude may be waiting on a first-run prompt (e.g. "trust this folder?") — or hooks are disabled by disableAllHooks / allowManagedHooksOnly / allowedHttpHookUrls, or claude failed to start.';
  } else if (s.inferred) {
    label += ' ?';
    chip.title = `Inferred: ${s.inferred}`;
  } else {
    chip.title = '';
  }
  if (['ready', 'permission', 'question', 'working', 'error'].includes(state)) label += ` · ${ago(now - s.since)}`;
  chip.textContent = label;
  view.bar.querySelector('.restart').classList.toggle('hidden', !(s.kind === 'claude' && (state === 'shell' || state === 'exited')));
}

function updateWaiting() {
  const waiting = [...S.panes.values()].filter(needsYou);
  const urgent = waiting.some(v => URGENT.has(effectiveState(v)));
  const btn = $('#waiting');
  btn.classList.toggle('hidden', !waiting.length);
  btn.classList.toggle('urgent', urgent);
  btn.textContent = `${waiting.length} waiting · Ctrl+Shift+Space`;
  const reveal = $('#toolbar-reveal');
  reveal.classList.toggle('waiting', waiting.length > 0 && !urgent);
  reveal.classList.toggle('urgent', urgent);
  api.setWaiting(waiting.length, waiting.length ? `(${waiting.length}) Asterism` : 'Asterism');
}

// ---------- Attention: sound + desktop notification ----------

let audio = null;
function beep(urgent) {
  if (!S.settings.sound) return;
  try {
    audio = audio || new AudioContext();
    const tones = urgent ? [880, 660, 880] : [660, 990];
    tones.forEach((f, i) => {
      const t0 = audio.currentTime + i * 0.13;
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
      o.connect(g).connect(audio.destination);
      o.start(t0);
      o.stop(t0 + 0.13);
    });
  } catch {}
}

function attention(view, prevState) {
  const s = view.status;
  if (!s.needsYou || s.state === prevState) return;
  const urgent = s.state !== 'ready';
  const looking = document.hasFocus() && S.focused === view.id;
  if (!looking) beep(urgent);
  if (S.settings.notifyDesktop) {
    const n = L.leafIds(S.tree).indexOf(view.id) + 1;
    const what = { ready: 'is ready for you', permission: 'needs permission', question: 'has a question', error: 'hit an error' }[s.state];
    api.notify(view.id, `Pane ${n} · ${s.name} ${what}`, oneLine(s.state === 'error' ? s.error : s.lastReply, 180) || shortPath(s.cwd));
  }
}

// ---------- IPC wiring ----------

api.onData((id, data) => {
  const v = S.panes.get(id);
  if (v) v.term.write(data);
  else if (!S.dead.has(id)) S.pending.set(id, (S.pending.get(id) || '') + data);
});

api.onStatus((id, snap) => {
  const v = S.panes.get(id);
  if (!v) return;
  const prev = v.status.state;
  v.status = snap;
  updateBar(v);
  attention(v, prev);
  updateWaiting();
  scheduleSessionSave();
});

api.onExit((id, code) => {
  const v = S.panes.get(id);
  if (!v) return;
  v.exited = true;
  v.term.write(`\r\n\x1b[2m[process exited${code ? ` with code ${code}` : ''} — press Enter to restart${v.launch.kind === 'claude' && v.status.sessionId ? ' and resume the session' : ''}]\x1b[0m\r\n`);
  updateBar(v);
  updateWaiting();
});

api.onScreenRequest((reqId, id, lines) => {
  const v = S.panes.get(id);
  api.screenReply(reqId, v ? readScreen(v.term, lines) : '(no such pane)');
});

api.onFocusPane(id => focusPane(id));

function readScreen(term, n) {
  const b = term.buffer.active;
  const text = i => { const line = b.getLine(i); return line ? line.translateToString(true) : ''; };
  let end = b.baseY + term.rows;
  while (end > 0 && !text(end - 1).trim()) end--;
  const out = [];
  for (let i = Math.max(0, end - n); i < end; i++) out.push(text(i));
  return out.join('\n');
}

// ---------- Projects & session persistence ----------

function serializeLayout() {
  const ids = L.leafIds(S.tree);
  const index = Object.fromEntries(ids.map((id, i) => [id, i]));
  const mapTree = n => n.type === 'pane' ? { type: 'pane', id: index[n.id] } : { ...n, children: n.children.map(mapTree) };
  return {
    preset: S.preset,
    custom: S.custom,
    tree: S.tree ? mapTree(S.tree) : null,
    panes: ids.map(id => {
      const v = S.panes.get(id);
      // Claude stores conversations per launch folder, so resume must use the folder it was started
      // in. A shell pane where the user typed `claude` is saved as a Claude pane.
      const kind = v.status.kind;
      const cwd = kind === 'claude' ? (v.status.startCwd || v.launch.cwd) : v.launch.cwd;
      const args = kind === v.launch.kind ? v.launch.args : [];
      return { kind, name: v.status.name, cwd, args, sessionId: v.status.sessionId || null };
    }),
    savedAt: Date.now(),
  };
}

let sessionTimer = null;
function flushSession() {
  clearTimeout(sessionTimer);
  if (S.restoring) return;
  // Inside a project an empty window is saved too (you closed its panes); outside one it isn't, so
  // the last session stays restorable.
  let ws;
  if (S.panes.size) ws = serializeLayout();
  else if (S.project) ws = { preset: S.preset, custom: false, tree: null, panes: [] };
  else return;
  api.saveSession(ws, S.project);
  S.lastSession = { ...ws, project: S.project };
  if (S.projects[S.project]) S.projects[S.project] = { ...S.projects[S.project], layout: ws };
}
function scheduleSessionSave() {
  if (S.restoring) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(flushSession, 300);
}
window.addEventListener('beforeunload', flushSession);

// Recreate a saved layout's panes. The caller closes whatever was open first.
async function openLayout(ws, { resume }) {
  if (!ws || !ws.panes || !ws.panes.length) return;
  S.restoring = true;
  const ids = [];
  try {
    for (const p of ws.panes) {
      ids.push(await newPane({ kind: p.kind, name: p.name, cwd: p.cwd, args: p.args || [], resume: resume && p.kind === 'claude' ? p.sessionId : null }));
    }
  } finally {
    S.restoring = false;
  }
  S.preset = ws.preset || 'grid';
  const created = ids.filter(Boolean);
  if (!created.length) { renderLayout(); return; }
  const mapTree = n => n.type === 'pane' ? { type: 'pane', id: ids[n.id] } : { ...n, children: n.children.map(mapTree) };
  const restored = ws.tree ? mapTree(ws.tree) : null;
  const valid = created.length === ids.length && restored && L.leafIds(restored).length === ids.length;
  S.tree = valid ? restored : L.buildPreset(S.preset, created);
  S.custom = !!(valid && ws.custom);
  renderLayout();
  focusPane(created[0]);
}

function closeAllPanes() {
  S.restoring = true;   // don't save the half-closed window over the project
  for (const id of [...S.panes.keys()]) disposeView(id);
  S.tree = null; S.zoomed = null; S.focused = null; S.custom = false;
  S.restoring = false;
}

function activeProject() { return S.projects[S.project] || null; }
function projectDir() { return activeProject()?.dir || ''; }

// Most common folder among the open panes: the natural folder for a project made from them.
function commonPaneDir() {
  const counts = new Map();
  for (const p of S.panes.size ? serializeLayout().panes : []) if (p.cwd) counts.set(p.cwd, (counts.get(p.cwd) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function updateProjectUi() {
  const p = activeProject();
  const b = $('#btn-project');
  b.textContent = p ? `${p.name} ▾` : 'No project ▾';
  b.title = p ? `Project ${p.name}: new Claude panes start in ${p.dir}` : 'Projects';
  b.classList.toggle('in-project', !!p);
  document.title = p ? `${p.name} · Asterism` : 'Asterism';
}

function busyCount() {
  return [...S.panes.values()].filter(v => ['working', 'permission', 'question'].includes(v.status.state)).length;
}

// Switch the window to a project: the current project keeps its panes (saved), then the new
// project's panes come back with their conversations resumed.
async function openProject(id) {
  const proj = S.projects[id];
  if (!proj || id === S.project) return;
  if (S.panes.size && !S.project && !confirm(`Close the ${S.panes.size} open pane(s)? They aren't in a project, so they won't be kept.`)) return;
  const busy = busyCount();
  if (busy && S.project && !confirm(`${busy} pane(s) are still busy. Switching projects stops them. Continue?`)) return;
  flushSession();
  closeAllPanes();
  S.project = id;
  updateProjectUi();
  await openLayout(proj.layout, { resume: true });
  renderLayout();
}

function leaveProject() {
  if (!S.project) return;
  const busy = busyCount();
  if (busy && !confirm(`${busy} pane(s) are still busy. Leaving the project stops them. Continue?`)) return;
  flushSession();
  closeAllPanes();
  S.project = null;
  updateProjectUi();
  renderLayout();
}

async function createProject({ name, dir, adopt }) {
  dir = dir.trim();
  name = name.trim() || dir.split(/[\\/]/).filter(Boolean).pop() || 'project';
  const res = await api.saveProject({ name, dir, layout: null });
  S.projects = res.projects;
  if (adopt) {
    // The open panes become the project's panes.
    S.project = res.id;
    updateProjectUi();
    flushSession();
    renderLayout();
  } else {
    await openProject(res.id);
  }
}

async function deleteProject(id) {
  const p = S.projects[id];
  if (!p || !confirm(`Delete project "${p.name}"? Its folder and Claude conversations are not touched.`)) return false;
  S.projects = await api.deleteProject(id);
  if (S.project === id) { S.project = null; updateProjectUi(); renderLayout(); }
  return true;
}

function renderEmpty() {
  const p = activeProject();
  $('#empty h1').textContent = p ? p.name : 'Asterism';
  $('#empty-sub').textContent = p ? `${shortPath(p.dir)} · no panes open yet` : 'Tiled Claude Code sessions with a status light on every pane.';
  $('#empty-hint').textContent = p
    ? 'Ctrl+Shift+N new Claude pane here · Ctrl+Shift+O pick another folder · Ctrl+Shift+L cycle layout'
    : 'Ctrl+Shift+N new Claude pane (asks for a folder) · Ctrl+Shift+Space jump to waiting pane · Ctrl+Shift+L cycle layout';
  const restore = $('#empty-restore');
  const ls = S.lastSession;
  const lsProj = ls && ls.project && S.projects[ls.project];
  const show = !p && (lsProj || (ls && !ls.project && ls.panes && ls.panes.length));
  restore.classList.toggle('hidden', !show);
  if (show) {
    restore.textContent = lsProj ? `Reopen ${lsProj.name}` : `Restore last session (${ls.panes.length} pane${ls.panes.length > 1 ? 's' : ''})`;
    restore.onclick = () => (lsProj ? openProject(lsProj.id) : openLayout(ls, { resume: true }));
  }
  const box = $('#empty-projects');
  box.replaceChildren(...(p ? [] : Object.values(S.projects).filter(x => x !== lsProj).sort((a, b) => a.name.localeCompare(b.name)).map(proj => {
    const b = document.createElement('button');
    b.textContent = `▸ ${proj.name}`;
    b.title = proj.dir;
    b.onclick = () => openProject(proj.id);
    return b;
  })));
}

// ---------- Popovers & modals ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showPopover(x, y, build) {
  // Swap in a fresh element each time so listeners from earlier popovers can't pile up.
  const old = $('#popover');
  const pop = old.cloneNode(false);
  old.replaceWith(pop);
  pop.classList.remove('hidden');
  build(pop);
  const r = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  pop.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
}
function hidePopover() {
  $('#popover').classList.add('hidden');
  if (!$('#toolbar').matches(':hover')) setPeek(false);
}
// The page and pane frames are fixed-size and never meant to scroll, but overflow:hidden boxes can
// still be scrolled by the browser, e.g. when a terminal grabs focus before it has been fitted. That
// slides a pane's header up under the toolbar, so snap any such scroll straight back.
const NO_SCROLL = '#stage, #grid, .split, .cell, .pane, .pane-bar, .pane-term';
document.addEventListener('scroll', e => {
  const t = e.target;
  if (t === document) { if (scrollX || scrollY) scrollTo(0, 0); return; }
  if (t instanceof Element && t.matches(NO_SCROLL) && (t.scrollTop || t.scrollLeft)) { t.scrollTop = 0; t.scrollLeft = 0; }
}, true);

function popoverOpen() { return !$('#popover').classList.contains('hidden'); }

document.addEventListener('mousedown', e => {
  if (popoverOpen() && !e.target.closest('#popover') && !e.target.closest('#toolbar button')) hidePopover();
});

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function newPanePopover(kind = 'claude', anchor = $('#btn-new-claude')) {
  const r = anchor.getBoundingClientRect();
  const focusedCwd = S.focused && S.panes.get(S.focused)?.status.cwd;
  const startDir = projectDir() || focusedCwd || S.recentDirs[0] || S.home;
  showPopover(r.left, r.bottom + 6, pop => {
    pop.innerHTML = `
      <h3>New ${kind === 'claude' ? 'Claude' : 'shell'} pane</h3>
      <label>Folder</label>
      <div class="row"><input id="np-dir" value="${esc(startDir)}" spellcheck="false"><button id="np-browse">Browse…</button></div>
      <label>Name (optional)</label>
      <input id="np-name" placeholder="defaults to the folder name">
      ${kind === 'claude' ? '<label>Extra claude arguments (optional)</label><input id="np-args" placeholder="e.g. --model opus --permission-mode plan" spellcheck="false">' : ''}
      ${S.recentDirs.length ? `<label>Recent folders — click to open</label><div class="list">${S.recentDirs.map((d, i) => `<button data-i="${i}" title="${esc(d)}">${esc(shortPath(d))}</button>`).join('')}</div>` : ''}
      <div class="actions"><button id="np-cancel">Cancel</button><button id="np-go" class="primary">Open (Enter)</button></div>`;
    const dir = pop.querySelector('#np-dir');
    const name = pop.querySelector('#np-name');
    const args = pop.querySelector('#np-args');
    let launched = false;
    const go = (cwd = dir.value.trim()) => {
      if (launched) return;
      launched = true;
      hidePopover();
      newPane({ kind, cwd, name: name.value.trim() || undefined, args: args ? splitArgs(args.value) : [] });
    };
    pop.querySelector('#np-browse').onclick = async () => { const d = await api.pickDir(dir.value); if (d) dir.value = d; };
    pop.querySelector('#np-cancel').onclick = hidePopover;
    pop.querySelector('#np-go').onclick = () => go();
    pop.querySelectorAll('.list button').forEach(b => { b.onclick = () => go(S.recentDirs[Number(b.dataset.i)]); });
    pop.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !e.repeat) { e.preventDefault(); go(); }
      if (e.key === 'Escape') hidePopover();
    });
    dir.focus();
    dir.select();
  });
}

function projectsPopover() {
  const r = $('#btn-project').getBoundingClientRect();
  showPopover(r.right - 380, r.bottom + 6, pop => {
    const list = Object.values(S.projects).sort((a, b) => a.name.localeCompare(b.name));
    const cur = activeProject();
    const ls = S.lastSession;
    const canRestore = !cur && !S.panes.size && ls && !ls.project && ls.panes && ls.panes.length;
    const adoptable = !cur && S.panes.size > 0;
    const startDir = (adoptable && commonPaneDir()) || S.recentDirs[0] || S.home;
    const count = p => ((p.layout && p.layout.panes) || []).length;
    pop.innerHTML = `
      <h3>Projects</h3>
      ${cur ? `<span class="muted">New Claude panes start in <b>${esc(shortPath(cur.dir))}</b>.</span>
        <div class="row"><button id="pj-edit">Edit ${esc(cur.name)}…</button><button id="pj-leave">Leave project</button></div>` : ''}
      ${canRestore ? `<div class="list"><button id="pj-last">↻ Restore last session (${ls.panes.length} panes)</button></div>` : ''}
      <label>Open a project</label>
      <div class="list">${list.length ? list.map((p, i) => `<div class="item"><button data-i="${i}" class="pj-open" title="${esc(p.dir)}">${p.id === S.project ? '●' : '▸'} ${esc(p.name)} <span class="muted">· ${esc(shortPath(p.dir))} · ${count(p)} pane${count(p) === 1 ? '' : 's'}</span></button><button data-i="${i}" class="pj-del" title="Delete project">✕</button></div>`).join('') : '<span class="muted">No projects yet.</span>'}</div>
      <label>New project</label>
      <div class="row"><input id="pj-dir" value="${esc(startDir)}" spellcheck="false" title="Folder"><button id="pj-browse">Browse…</button></div>
      <input id="pj-name" placeholder="name (defaults to the folder name)">
      ${adoptable ? `<label class="check"><input id="pj-adopt" type="checkbox" checked> Keep the ${S.panes.size} open pane${S.panes.size > 1 ? 's' : ''} in it</label>` : ''}
      <div class="actions"><button id="pj-create" class="primary">Create</button></div>
      <span class="muted">A project is a folder and its panes. New panes open in the folder, and the layout is saved as you work.</span>`;
    const q = s => pop.querySelector(s);
    if (q('#pj-edit')) q('#pj-edit').onclick = () => { hidePopover(); projectModal(cur.id); };
    if (q('#pj-leave')) q('#pj-leave').onclick = () => { hidePopover(); leaveProject(); };
    if (q('#pj-last')) q('#pj-last').onclick = () => { hidePopover(); openLayout(ls, { resume: true }); };
    pop.querySelectorAll('.pj-open').forEach(b => { b.onclick = () => { hidePopover(); openProject(list[b.dataset.i].id); }; });
    pop.querySelectorAll('.pj-del').forEach(b => {
      b.onclick = async () => { if (await deleteProject(list[b.dataset.i].id)) projectsPopover(); };
    });
    q('#pj-browse').onclick = async () => { const d = await api.pickDir(q('#pj-dir').value); if (d) q('#pj-dir').value = d; };
    let created = false;
    const create = () => {
      const dir = q('#pj-dir').value.trim();
      if (!dir || created) return;
      created = true;
      hidePopover();
      createProject({ name: q('#pj-name').value, dir, adopt: !!(q('#pj-adopt') && q('#pj-adopt').checked) });
    };
    q('#pj-create').onclick = create;
    pop.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.repeat && (e.target.id === 'pj-name' || e.target.id === 'pj-dir')) { e.preventDefault(); create(); }
      if (e.key === 'Escape') hidePopover();
    });
    q('#pj-dir').focus();
  });
}

// Rename a project or change its folder. Panes already open stay where they are.
function projectModal(id) {
  const p = S.projects[id];
  if (!p) return;
  const m = $('#modal');
  m.innerHTML = `
    <h2>Project</h2>
    <label>Name</label>
    <input id="pm-name" value="${esc(p.name)}" spellcheck="false">
    <label>Folder (new panes start here; open panes stay where they are)</label>
    <div class="row"><input id="pm-dir" value="${esc(p.dir)}" spellcheck="false"><button id="pm-browse">Browse…</button></div>
    <div class="actions"><button id="pm-cancel">Cancel</button><button id="pm-save" class="primary">Save</button></div>`;
  $('#modal-backdrop').classList.remove('hidden');
  const q = s => m.querySelector(s);
  const close = () => $('#modal-backdrop').classList.add('hidden');
  q('#pm-browse').onclick = async () => { const d = await api.pickDir(q('#pm-dir').value); if (d) q('#pm-dir').value = d; };
  q('#pm-cancel').onclick = close;
  q('#pm-save').onclick = async () => {
    const name = q('#pm-name').value.trim();
    const dir = q('#pm-dir').value.trim();
    if (!name || !dir) return;
    S.projects = (await api.saveProject({ id, name, dir })).projects;
    close();
    updateProjectUi();
    if (!S.panes.size) renderLayout();
  };
  q('#pm-name').focus();
}

const SHORTCUTS = [
  ['Ctrl+Shift+Space', 'Jump to the pane that has waited longest (press again to cycle)'],
  ['Ctrl+Shift+N', 'New Claude pane in the project folder (asks for a folder outside a project)'],
  ['Ctrl+Shift+O', 'New Claude pane in a folder you pick'],
  ['Ctrl+Shift+T', 'New shell pane in the focused pane\'s folder'],
  ['Ctrl+Shift+W', 'Close focused pane'],
  ['Ctrl+Shift+Enter', 'Zoom / unzoom focused pane'],
  ['Ctrl+Shift+Arrows', 'Move focus between panes'],
  ['Ctrl+Shift+1…9', 'Focus pane by number'],
  ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous pane'],
  ['Ctrl+Shift+L', 'Cycle layout'],
  ['Ctrl+Shift+R', 'Rename focused pane'],
  ['Ctrl+Shift+F', 'Search the focused pane\'s scrollback'],
  ['Ctrl+Shift+C / V', 'Copy selection / paste (right-click does the same)'],
  ['Ctrl+Shift+= / -', 'Font size'],
  ['Shift+Enter', 'Newline in the Claude prompt'],
  ['Drag a title bar', 'Swap two panes'],
  ['Double-click a title bar', 'Zoom; double-click a divider to even it out'],
  ['F11', 'Fullscreen'],
  ['Ctrl+Shift+H', 'Hide / show the toolbar (when hidden, hover the top edge to slide it down)'],
  ['F12', 'Developer tools'],
];

function settingsModal() {
  const m = $('#modal');
  const st = S.settings;
  m.innerHTML = `
    <h2>Settings</h2>
    <label>Theme (click to preview)</label>
    ${themePicker(st.theme)}
    <label>Claude command</label>
    <input id="set-cmd" value="${esc(st.claudeCommand)}" spellcheck="false">
    <label>Shell (blank = ${api.platform === 'win32' ? 'pwsh, falling back to Windows PowerShell' : '$SHELL'})</label>
    <input id="set-shell" value="${esc(st.shell)}" spellcheck="false" placeholder="${api.platform === 'win32' ? 'pwsh.exe' : '/bin/bash'}">
    <div class="row">
      <div style="flex:1"><label>Font size</label><input id="set-fs" type="number" min="8" max="32" value="${st.fontSize}"></div>
      <div style="flex:3"><label>Font family (blank = default)</label><input id="set-ff" value="${esc(st.fontFamily)}" spellcheck="false"></div>
    </div>
    <label class="check"><input id="set-notify" type="checkbox" ${st.notifyDesktop ? 'checked' : ''}> Desktop notification when a pane needs you and Asterism isn't focused</label>
    <label class="check"><input id="set-sound" type="checkbox" ${st.sound ? 'checked' : ''}> Sound when a pane you aren't looking at needs you</label>
    <h2 style="margin-top:8px">Shortcuts</h2>
    <div class="keys">${SHORTCUTS.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join('')}</div>
    <div class="actions"><span class="muted" style="margin-right:auto;align-self:center">Asterism v${esc(S.version)}</span><button id="set-cancel">Cancel</button><button id="set-save" class="primary">Save</button></div>`;
  $('#modal-backdrop').classList.remove('hidden');
  const q = s => m.querySelector(s);
  // Theme cards preview live; Cancel / Escape put the saved theme back.
  let theme = getTheme(st.theme).id;
  m.querySelectorAll('.theme-card').forEach(b => {
    b.onclick = () => {
      theme = b.dataset.theme;
      m.querySelectorAll('.theme-card').forEach(x => x.classList.toggle('active', x === b));
      applyTheme(theme);
    };
  });
  S.onModalDismiss = () => applyTheme(st.theme);
  const close = () => { S.onModalDismiss = null; $('#modal-backdrop').classList.add('hidden'); };
  q('#set-cancel').onclick = () => { applyTheme(st.theme); close(); };
  q('#set-save').onclick = async () => {
    S.settings = await api.saveSettings({
      theme,
      themeBg: getTheme(theme).bg,
      claudeCommand: q('#set-cmd').value.trim() || 'claude',
      shell: q('#set-shell').value.trim(),
      fontSize: Math.min(32, Math.max(8, Number(q('#set-fs').value) || 13)),
      fontFamily: q('#set-ff').value.trim(),
      notifyDesktop: q('#set-notify').checked,
      sound: q('#set-sound').checked,
    });
    applyFont();
    close();
  };
}

function applyTheme(id = S.settings.theme) {
  const t = getTheme(id);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(cssVars(t))) root.style.setProperty(k, v);
  root.style.colorScheme = t.dark ? 'dark' : 'light';
  const tt = termTheme(t);
  for (const v of S.panes.values()) v.term.options.theme = tt;
}

function themePicker(current, onPick) {
  return `<div class="themes">${THEMES.map(t => `<button class="theme-card${t.id === current ? ' active' : ''}" data-theme="${t.id}" style="background:${t.panel};color:${t.text};border-color:${t.lineStrong}">
    <span>${esc(t.label)}</span>
    <span class="theme-swatch"><i style="background:${t.bg}"></i>${[t.accent, t.ansi[2], t.ansi[3], t.ansi[1], t.ansi[5]].map(c => `<i style="background:${c}"></i>`).join('')}</span>
  </button>`).join('')}</div>`;
}

function applyFont() {
  for (const v of S.panes.values()) {
    v.term.options.fontSize = S.settings.fontSize;
    v.term.options.fontFamily = S.settings.fontFamily || DEFAULT_FONT;
    scheduleFit(v);
  }
}

async function bumpFont(delta) {
  S.settings = await api.saveSettings({ fontSize: Math.min(32, Math.max(8, (S.settings.fontSize || 13) + delta)) });
  applyFont();
}

// ---------- Toolbar hide / peek ----------

let peekTimer = null;
function setPeek(on) {
  clearTimeout(peekTimer);
  document.body.classList.toggle('toolbar-peek', on);
}

function applyToolbarHidden() {
  document.body.classList.toggle('toolbar-hidden', !!S.settings.toolbarHidden);
  setPeek(false);
}

async function toggleToolbar() {
  S.settings = await api.saveSettings({ toolbarHidden: !S.settings.toolbarHidden });
  hidePopover();
  applyToolbarHidden();
}

function wireToolbarPeek() {
  $('#toolbar-reveal').addEventListener('mouseenter', () => setPeek(true));
  $('#toolbar').addEventListener('mouseenter', () => clearTimeout(peekTimer));
  $('#toolbar').addEventListener('mouseleave', () => {
    if (!document.body.classList.contains('toolbar-hidden') || popoverOpen()) return;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => setPeek(false), 300);
  });
}

// ---------- Hotkeys ----------

function cyclePane(step) {
  const ids = L.leafIds(S.tree);
  if (!ids.length) return;
  const i = ids.indexOf(S.focused);
  focusPane(ids[i < 0 ? 0 : (i + step + ids.length) % ids.length]);
}

function handleHotkey(e) {
  if (!e.ctrlKey || e.altKey || e.metaKey) return false;
  const modalOpen = !$('#modal-backdrop').classList.contains('hidden');
  if (modalOpen) return false;
  // Ctrl+Tab / Ctrl+Shift+Tab: next / previous pane, in pane-number order, wrapping at the ends.
  if (e.code === 'Tab') { cyclePane(e.shiftKey ? -1 : 1); return true; }
  if (!e.shiftKey) return false;
  // Held-down keys auto-repeat; never let that open, close or re-layout panes repeatedly.
  if (e.repeat && ['KeyN', 'KeyO', 'KeyT', 'KeyW', 'KeyL', 'Enter', 'KeyR', 'KeyF', 'KeyH'].includes(e.code)) return true;
  const v = S.focused && S.panes.get(S.focused);
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) {
    const id = L.leafIds(S.tree)[Number(digit[1]) - 1];
    if (id) focusPane(id);
    return true;
  }
  switch (e.code) {
    case 'Space': jumpToWaiting(); return true;
    case 'KeyN': if (projectDir()) newPane({ kind: 'claude', cwd: projectDir() }); else newPanePopover('claude'); return true;
    case 'KeyO': newPanePopover('claude'); return true;
    case 'KeyT': newPane({ kind: 'shell', cwd: (v && v.status.cwd) || projectDir() || S.recentDirs[0] || S.home }); return true;
    case 'KeyW': if (v) closePane(v.id); return true;
    case 'Enter': toggleZoom(); return true;
    case 'ArrowLeft': moveFocus('left'); return true;
    case 'ArrowRight': moveFocus('right'); return true;
    case 'ArrowUp': moveFocus('up'); return true;
    case 'ArrowDown': moveFocus('down'); return true;
    case 'KeyL': {
      const i = L.PRESETS.findIndex(p => p.id === S.preset);
      setPreset(L.PRESETS[(i + 1) % L.PRESETS.length].id);
      return true;
    }
    case 'KeyR': if (v) renamePrompt(v.id); return true;
    case 'KeyF': if (v) openSearch(v); return true;
    case 'KeyH': toggleToolbar(); return true;
    case 'KeyC': if (v && v.term.hasSelection()) { api.clipboardWrite(v.term.getSelection()); v.term.clearSelection(); } return true;
    case 'KeyV': if (v) api.clipboardRead().then(t => { if (t) v.term.paste(t); }); return true;
    case 'Equal': bumpFont(1); return true;
    case 'Minus': bumpFont(-1); return true;
    default: return false;
  }
}

window.addEventListener('keydown', e => {
  if (handleHotkey(e)) { e.preventDefault(); e.stopPropagation(); }
  else if (e.key === 'Escape' && !$('#modal-backdrop').classList.contains('hidden')) {
    if (S.onModalDismiss) S.onModalDismiss();
    S.onModalDismiss = null;
    $('#modal-backdrop').classList.add('hidden');
  }
}, true);

// ---------- Toolbar ----------

const ICONS = {
  grid: [2, 2, 4], columns: [4, 1, 4], rows: [1, 3, 3], 'main-left': null, 'main-top': null,
};
function layoutIcon(id) {
  const box = document.createElement('span');
  box.className = 'layout-icon';
  if (id === 'main-left') {
    box.style.gridTemplate = '1fr 1fr 1fr / 3fr 2fr';
    box.innerHTML = '<i style="grid-row:1/4"></i><i></i><i></i><i></i>';
  } else if (id === 'main-top') {
    box.style.gridTemplate = '3fr 2fr / 1fr 1fr 1fr';
    box.innerHTML = '<i style="grid-column:1/4"></i><i></i><i></i><i></i>';
  } else {
    const [c, r, n] = ICONS[id];
    box.style.gridTemplate = `repeat(${r}, 1fr) / repeat(${c}, 1fr)`;
    box.innerHTML = '<i></i>'.repeat(n);
  }
  return box;
}

function buildToolbar() {
  const box = $('#layouts');
  for (const p of L.PRESETS) {
    const b = document.createElement('button');
    b.dataset.preset = p.id;
    b.title = `${p.label} layout (Ctrl+Shift+L cycles)`;
    b.appendChild(layoutIcon(p.id));
    b.onclick = () => setPreset(p.id);
    box.appendChild(b);
  }
  $('#btn-new-claude').onclick = () => newPanePopover('claude', $('#btn-new-claude'));
  $('#btn-new-shell').onclick = () => newPanePopover('shell', $('#btn-new-shell'));
  $('#btn-project').onclick = () => (popoverOpen() ? hidePopover() : projectsPopover());
  $('#btn-settings').onclick = settingsModal;
  $('#waiting').onclick = jumpToWaiting;
  $('#empty-new').onclick = () => (projectDir() ? newPane({ kind: 'claude', cwd: projectDir() }) : newPanePopover('claude', $('#empty-new')));
  $('#modal-backdrop').addEventListener('mousedown', e => { if (e.target.id === 'modal-backdrop') $('#modal-backdrop').classList.add('hidden'); });
}

// Refresh the "for 2m" timers on chips.
setInterval(() => { for (const v of S.panes.values()) updateBar(v); updateWaiting(); }, 5000);

// ---------- Boot ----------

(async () => {
  const init = await api.init();
  Object.assign(S, {
    settings: init.settings, projects: init.projects || {}, lastSession: init.lastSession,
    recentDirs: init.recentDirs || [], home: init.home, version: init.version || '',
  });
  buildToolbar();
  wireToolbarPeek();
  applyTheme();
  applyToolbarHidden();
  updateProjectUi();
  renderLayout();
  if (init.test) {
    window.__asterismTest = {
      newPane, newPanePopover, applyTheme, settingsModal, setPreset, focusPane, setPeek, closePane, jumpToWaiting, toggleZoom, openLayout, serializeLayout,
      openProject, leaveProject, createProject, projectsPopover,
      state: () => ({
        order: L.leafIds(S.tree), focused: S.focused, preset: S.preset, zoomed: S.zoomed, project: S.project,
        panes: [...S.panes.values()].map(v => ({ id: v.id, state: v.el.dataset.state, chip: v.bar.querySelector('.pane-chip').textContent, cols: v.term.cols, rows: v.term.rows, termBg: v.term.options.theme && v.term.options.theme.background, screen: readScreen(v.term, 200) })),
      }),
    };
  }
})();
