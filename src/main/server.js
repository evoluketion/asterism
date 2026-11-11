'use strict';

const http = require('http');
const crypto = require('crypto');

const MAX_BODY = 8 * 1024 * 1024;
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const FALLBACK_PROTOCOL = '2025-06-18';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let truncated = false;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { truncated = true; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(truncated ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(a || '');
  const y = Buffer.from(b || '');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// handlers: { hook(paneId, event, body), tools: [{name, description, inputSchema}], callTool(paneId, name, args) -> string }
function createServer(handlers) {
  // Each pane gets its own token (HMAC of its id), checked against the pane id in the URL, so one
  // pane's Claude can't forge hook events or MCP calls as another pane.
  const secret = crypto.randomBytes(32);
  const tokenFor = paneId => crypto.createHmac('sha256', secret).update(String(paneId)).digest('hex');
  let port = 0;

  const server = http.createServer(async (req, res) => {
    const end = (code, body, headers = {}) => {
      res.writeHead(code, headers);
      res.end(body);
    };
    try {
      // Only local, non-browser clients: blocks DNS-rebinding and cross-origin page requests.
      const host = req.headers.host || '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return end(403);
      if (req.headers.origin) return end(403);
      const parts = req.url.split('?')[0].split('/').filter(Boolean);
      if (parts.length < 2 || !safeEqual(req.headers.authorization, `Bearer ${tokenFor(parts[1])}`)) return end(401);

      if (parts[0] === 'hook' && parts.length === 3 && req.method === 'POST') {
        const raw = await readBody(req);
        let body = {};
        if (raw) { try { body = JSON.parse(raw) || {}; } catch {} }
        if (typeof body !== 'object') body = {};
        handlers.hook(parts[1], parts[2], body);
        return end(204);
      }
      if (parts[0] === 'mcp' && parts.length === 2) {
        if (req.method !== 'POST') return end(405, '', { Allow: 'POST' });
        const raw = await readBody(req);
        let msg;
        try { msg = JSON.parse(raw); } catch {
          return end(400, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), { 'Content-Type': 'application/json' });
        }
        const batch = Array.isArray(msg);
        const replies = [];
        for (const m of batch ? msg : [msg]) {
          const r = await handleRpc(parts[1], m);
          if (r) replies.push(r);
        }
        if (!replies.length) return end(202);
        return end(200, JSON.stringify(batch ? replies : replies[0]), { 'Content-Type': 'application/json' });
      }
      end(404);
    } catch (err) {
      end(500, String(err && err.message));
    }
  });

  async function handleRpc(paneId, m) {
    if (!m || typeof m !== 'object') return null;
    const isRequest = m.id !== undefined && m.id !== null;
    const ok = result => ({ jsonrpc: '2.0', id: m.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    if (!isRequest) return null; // notifications (initialized, cancelled, ...)
    switch (m.method) {
      case 'initialize': {
        const asked = m.params && m.params.protocolVersion;
        return ok({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : FALLBACK_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'asterism', version: '0.1.0' },
          instructions: 'You are running in one pane of Asterism, a tiled terminal that runs several Claude Code sessions side by side. These tools show what the other panes are doing.',
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: handlers.tools });
      case 'tools/call': {
        const { name, arguments: args } = m.params || {};
        if (!handlers.tools.some(t => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
        try {
          const text = await handlers.callTool(paneId, name, args || {});
          return ok({ content: [{ type: 'text', text }] });
        } catch (err) {
          return ok({ content: [{ type: 'text', text: String(err && err.message || err) }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${m.method}`);
    }
  }

  return {
    tokenFor,
    get port() { return port; },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          port = server.address().port;
          resolve(port);
        });
      });
    },
    close() { server.close(); },
  };
}

module.exports = { createServer };
