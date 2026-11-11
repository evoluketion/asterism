'use strict';

const { readTurns } = require('./transcript');

const PANE_ARG = {
  type: 'string',
  description: 'Pane name (preferred — numbers change when panes are added, closed or rearranged) or its current number from list_panes.',
};

const TOOLS = [
  {
    name: 'list_panes',
    description: 'List every pane in this Asterism window: number, name, state (working / ready / permission / question / error / idle / shell / exited), how long it has been in that state, working directory, git branch, the last prompt it was given, a short excerpt of its last reply, and the tool it is currently running. The pane with "you": true is the caller. Refer to panes by name: numbers follow on-screen order and change when panes are added, closed or swapped.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_pane_transcript',
    description: "Read the recent conversation of another pane's Claude Code session (user prompts, assistant replies, and the names of tools it used).",
    inputSchema: {
      type: 'object',
      properties: {
        pane: PANE_ARG,
        messages: { type: 'integer', minimum: 1, maximum: 50, description: 'How many recent turns to return (default 10).' },
      },
      required: ['pane'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_pane_screen',
    description: 'Read the text currently visible in another pane\'s terminal (useful for shell panes or to see a prompt that is waiting).',
    inputSchema: {
      type: 'object',
      properties: {
        pane: PANE_ARG,
        lines: { type: 'integer', minimum: 1, maximum: 500, description: 'How many lines from the bottom (default 60).' },
      },
      required: ['pane'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function excerpt(text, n) {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

// manager: PaneManager; getOrder(): pane ids in on-screen order; readScreen(id, lines): Promise<string>
function createToolHandler({ manager, getOrder, readScreen }) {
  function ordered() {
    const order = getOrder();
    const all = manager.list();
    const rank = id => { const i = order.indexOf(id); return i < 0 ? 1e9 : i; };
    return all.sort((a, b) => rank(a.id) - rank(b.id));
  }

  function resolve(ref) {
    const panes = ordered();
    const s = String(ref ?? '').trim();
    const byNum = /^\d+$/.test(s) ? panes[Number(s) - 1] : null;
    const hit = byNum || panes.find(p => p.id === s) || panes.find(p => p.name.toLowerCase() === s.toLowerCase());
    if (!hit) throw new Error(`No pane "${s}". Call list_panes to see the available panes.`);
    return { pane: hit, number: panes.indexOf(hit) + 1 };
  }

  async function callTool(callerId, name, args) {
    if (name === 'list_panes') {
      await Promise.all([...manager.panes.values()].map(p => manager.refreshBranch(p)));
      const now = Date.now();
      const rows = ordered().map((p, i) => ({
        pane: i + 1,
        name: p.name,
        you: p.id === callerId || undefined,
        kind: p.kind,
        state: p.state,
        for: ago(now - p.since),
        inferred: p.inferred || undefined,
        cwd: p.cwd,
        branch: p.branch || undefined,
        current_tool: p.state === 'working' ? p.currentTool || undefined : undefined,
        last_prompt: excerpt(p.lastPrompt, 300) || undefined,
        last_reply: excerpt(p.lastReply, 500) || undefined,
        error: p.error || undefined,
      }));
      return JSON.stringify(rows, null, 2);
    }
    if (name === 'get_pane_transcript') {
      const { pane, number } = resolve(args.pane);
      const live = manager.get(pane.id);
      if (pane.kind !== 'claude') throw new Error(`Pane ${number} is a shell pane; use read_pane_screen.`);
      const n = Math.min(Math.max(Number(args.messages) || 10, 1), 50);
      const turns = await readTurns(live && live.status.transcriptPath);
      if (!turns.length) return `Pane ${number} (${pane.name}) has no transcript yet.`;
      const lines = turns.slice(-n).map(t => t.role === 'tool' ? `[tool: ${t.name}]` : `${t.role.toUpperCase()}: ${t.text.length > 4000 ? t.text.slice(0, 4000) + '…' : t.text}`);
      return `Pane ${number} (${pane.name}), state ${pane.state}:\n\n${lines.join('\n\n')}`;
    }
    if (name === 'read_pane_screen') {
      const { pane, number } = resolve(args.pane);
      const n = Math.min(Math.max(Number(args.lines) || 60, 1), 500);
      const text = await readScreen(pane.id, n);
      return `Pane ${number} (${pane.name}) screen, last ${n} lines:\n\n${text}`;
    }
    throw new Error(`Unknown tool ${name}`);
  }

  return { tools: TOOLS, callTool };
}

module.exports = { createToolHandler, TOOLS };
