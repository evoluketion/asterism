// Pure split-tree layout logic. No DOM. Shared by the renderer and the tests.
// Tree node: { type: 'pane', id } | { type: 'split', dir: 'row' | 'col', children: Node[], sizes: number[] }
// 'row' lays children left→right, 'col' top→bottom. sizes are fractions summing to 1.

export const PRESETS = [
  { id: 'grid', label: 'Grid' },
  { id: 'columns', label: 'Columns' },
  { id: 'rows', label: 'Rows' },
  { id: 'main-left', label: 'Main + stack' },
  { id: 'main-top', label: 'Main + row' },
];

const leaf = id => ({ type: 'pane', id });
const even = n => Array.from({ length: n }, () => 1 / n);

function split(dir, children, sizes) {
  if (children.length === 1) return children[0];
  return { type: 'split', dir, children, sizes: sizes || even(children.length) };
}

export function buildPreset(preset, ids) {
  const n = ids.length;
  if (!n) return null;
  if (n === 1) return leaf(ids[0]);
  const leaves = ids.map(leaf);
  switch (preset) {
    case 'columns':
      return split('row', leaves);
    case 'rows':
      return split('col', leaves);
    case 'main-left':
      return split('row', [leaves[0], split('col', leaves.slice(1))], [0.6, 0.4]);
    case 'main-top':
      return split('col', [leaves[0], split('row', leaves.slice(1))], [0.6, 0.4]);
    case 'grid':
    default: {
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const out = [];
      for (let r = 0; r < rows; r++) out.push(split('row', leaves.slice(r * cols, (r + 1) * cols)));
      return split('col', out);
    }
  }
}

export function leafIds(tree) {
  if (!tree) return [];
  if (tree.type === 'pane') return [tree.id];
  return tree.children.flatMap(leafIds);
}

function normalize(sizes) {
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return sizes.map(s => s / total);
}

export function removePane(tree, id) {
  if (!tree) return null;
  if (tree.type === 'pane') return tree.id === id ? null : tree;
  const kept = [];
  const sizes = [];
  tree.children.forEach((c, i) => {
    const next = removePane(c, id);
    if (next) { kept.push(next); sizes.push(tree.sizes[i]); }
  });
  if (!kept.length) return null;
  if (kept.length === 1) return kept[0];
  return { ...tree, children: kept, sizes: normalize(sizes) };
}

// Split pane `targetId` in direction `dir`, putting `newId` after it.
export function splitPane(tree, targetId, newId, dir) {
  if (!tree) return leaf(newId);
  if (tree.type === 'pane') {
    if (tree.id !== targetId) return tree;
    return split(dir, [tree, leaf(newId)]);
  }
  const i = tree.children.findIndex(c => c.type === 'pane' && c.id === targetId);
  if (i >= 0 && tree.dir === dir) {
    const children = [...tree.children];
    children.splice(i + 1, 0, leaf(newId));
    const sizes = [...tree.sizes];
    const half = sizes[i] / 2;
    sizes.splice(i, 1, half, half);
    return { ...tree, children, sizes };
  }
  return { ...tree, children: tree.children.map(c => splitPane(c, targetId, newId, dir)) };
}

export function swapPanes(tree, a, b) {
  if (!tree) return tree;
  if (tree.type === 'pane') {
    if (tree.id === a) return leaf(b);
    if (tree.id === b) return leaf(a);
    return tree;
  }
  return { ...tree, children: tree.children.map(c => swapPanes(c, a, b)) };
}

// Resize: move the divider between children i and i+1 of the split at `path`.
export function setSizesAt(tree, path, sizes) {
  if (!path.length) return { ...tree, sizes: normalize(sizes) };
  const [head, ...rest] = path;
  const children = [...tree.children];
  children[head] = setSizesAt(children[head], rest, sizes);
  return { ...tree, children };
}

// Geometry: given {id: {x, y, w, h}}, find the nearest pane from `fromId` in `dir` (left/right/up/down).
export function findNeighbor(rects, fromId, dir) {
  const a = rects[fromId];
  if (!a) return null;
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  let best = null;
  let bestScore = Infinity;
  for (const [id, r] of Object.entries(rects)) {
    if (id === fromId) continue;
    let gap;
    let overlap;
    switch (dir) {
      case 'left': gap = a.x - (r.x + r.w); overlap = Math.min(a.y + a.h, r.y + r.h) - Math.max(a.y, r.y); break;
      case 'right': gap = r.x - (a.x + a.w); overlap = Math.min(a.y + a.h, r.y + r.h) - Math.max(a.y, r.y); break;
      case 'up': gap = a.y - (r.y + r.h); overlap = Math.min(a.x + a.w, r.x + r.w) - Math.max(a.x, r.x); break;
      case 'down': gap = r.y - (a.y + a.h); overlap = Math.min(a.x + a.w, r.x + r.w) - Math.max(a.x, r.x); break;
      default: return null;
    }
    if (gap < -2 || overlap <= 0) continue;
    const off = dir === 'left' || dir === 'right' ? Math.abs(r.y + r.h / 2 - cy) : Math.abs(r.x + r.w / 2 - cx);
    const score = gap * 10 + off;
    if (score < bestScore) { bestScore = score; best = id; }
  }
  return best;
}

// Which panes need attention first: blocked (permission/question/error) before ready, oldest first.
export function waitingOrder(statuses) {
  const urgency = s => (s.state === 'ready' ? 1 : 0);
  return Object.entries(statuses)
    .filter(([, s]) => s && s.needsYou)
    .sort(([, x], [, y]) => urgency(x) - urgency(y) || x.since - y.since)
    .map(([id]) => id);
}
