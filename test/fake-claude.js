#!/usr/bin/env node
'use strict';
// Stand-in for `claude` used by the self-test. It reads the --settings / --mcp-config files Asterism
// generated and fires the hooks exactly as Claude Code would (exec-form SessionStart, HTTP hooks),
// so the whole pipeline is exercised without spending tokens.
// Commands typed into it: work, tool <name>, perm, ask, done <text>, fail, mcp, quit

const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const settings = JSON.parse(fs.readFileSync(opt('--settings'), 'utf8'));
const mcp = JSON.parse(fs.readFileSync(opt('--mcp-config'), 'utf8')).mcpServers.asterism;
const sessionId = opt('--resume') || 'fake-' + Math.random().toString(36).slice(2, 10);
const base = { session_id: sessionId, transcript_path: '', cwd: process.cwd(), permission_mode: 'default' };

function fire(event, extra = {}) {
  const body = JSON.stringify({ ...base, hook_event_name: event, ...extra });
  const groups = (settings.hooks[event] || []);
  return Promise.all(groups.flatMap(g => g.hooks).map(h => {
    if (h.type === 'http') {
      return fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h.headers }, body }).then(r => r.status);
    }
    return new Promise(resolve => {
      const p = spawn(h.command, h.args || [], { stdio: ['pipe', 'ignore', 'ignore'] });
      p.on('exit', resolve);
      p.on('error', () => resolve(-1));
      p.stdin.end(body);
    });
  }));
}

async function rpc(method, params, id) {
  const r = await fetch(mcp.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...mcp.headers },
    body: JSON.stringify(id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
  });
  return r.status === 202 ? null : r.json();
}

const name = opt('-n') || 'fake';
process.stdout.write(`\x1b[38;5;208m✻\x1b[0m Fake Claude Code (${name})  session ${sessionId}\r\n> `);

(async () => {
  await fire('SessionStart', { source: opt('--resume') ? 'resume' : 'startup' });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async line => {
    const [cmd, ...rest] = line.trim().split(' ');
    const text = rest.join(' ');
    switch (cmd) {
      case 'work': await fire('UserPromptSubmit', { prompt: text || 'Refactor the auth middleware and add tests' }); await fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }); break;
      case 'tool': await fire('PreToolUse', { tool_name: text || 'Edit' }); break;
      case 'perm': await fire('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }); await fire('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }); break;
      case 'ask': await fire('PreToolUse', { tool_name: 'AskUserQuestion' }); break;
      case 'done': await fire('Stop', { stop_hook_active: false, last_assistant_message: text || 'Done. All 42 tests pass and the middleware now validates tokens before routing.' }); break;
      case 'fail': await fire('StopFailure', { error: 'API Error: 529 overloaded' }); break;
      case 'mcp': {
        const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake', version: '0' } }, 1);
        await rpc('notifications/initialized', {});
        const list = await rpc('tools/list', {}, 2);
        const call = await rpc('tools/call', { name: 'list_panes', arguments: {} }, 3);
        const screen = await rpc('tools/call', { name: 'read_pane_screen', arguments: { pane: '1', lines: 5 } }, 4);
        const out = { protocol: init.result.protocolVersion, tools: list.result.tools.map(t => t.name), panes: JSON.parse(call.result.content[0].text), screen: screen.result.content[0].text };
        fs.writeFileSync(process.env.ASTERISM_MCP_OUT || 'mcp-out.json', JSON.stringify(out, null, 2));
        process.stdout.write('mcp ok\r\n');
        break;
      }
      case 'quit': await fire('SessionEnd', { reason: 'prompt_input_exit' }); process.exit(0);
    }
    process.stdout.write('> ');
  });
})();
