'use strict';

const fs = require('fs/promises');

const TAIL_BYTES = 512 * 1024;

async function readTail(path) {
  const fh = await fs.open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line is probably partial
    return lines;
  } finally {
    await fh.close();
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
}

// Parse transcript JSONL into simple turns: {role, text} and {role:'tool', name}.
function parseTurns(lines) {
  const turns = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain || e.isMeta || !e.message) continue;
    const content = e.message.content;
    if (e.type === 'user') {
      if (Array.isArray(content) && content.some(b => b && b.type === 'tool_result')) continue;
      const text = textOf(content).trim();
      if (text && !text.startsWith('<command-') && !text.startsWith('<local-command')) turns.push({ role: 'user', text });
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text.trim()) turns.push({ role: 'assistant', text: b.text.trim() });
        else if (b.type === 'tool_use') turns.push({ role: 'tool', name: b.name });
      }
    }
  }
  return turns;
}

async function readTurns(path) {
  if (!path) return [];
  try {
    return parseTurns(await readTail(path));
  } catch {
    return [];
  }
}

async function lastAssistantText(path) {
  const turns = await readTurns(path);
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'assistant') return turns[i].text;
  return null;
}

module.exports = { parseTurns, readTurns, lastAssistantText };
