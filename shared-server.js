#!/usr/bin/env node
// shared-server.js — persistent visualization server for claude-mindmap
// Run once; multiple MCP server.js instances connect to it via HTTP.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.MINDMAP_PORT || '3333');

// ── Session State ─────────────────────────────────────────────

const sessions = new Map(); // sessionId → Session

function makeSession(sessionId, pid) {
  return {
    sessionId,
    pid: pid || 0,
    label: `Session ${sessionId.slice(0, 8)}`,
    model: null,
    nodes: new Map(),
    rootId: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    sessionStart: Date.now(),
    lastActivity: Date.now(),
    active: true
  };
}

function resetSession(sess) {
  sess.nodes.clear();
  sess.rootId = null;
  sess.totalInputTokens = 0;
  sess.totalOutputTokens = 0;
  sess.sessionStart = Date.now();
  sess.lastActivity = Date.now();
}

function addNode(sess, id, parentId, label, detail, type, inputTokens, outputTokens) {
  const node = {
    id, parentId, label,
    detail: detail || '',
    type: type || 'thought',
    status: 'active',
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
    children: [],
    createdAt: Date.now()
  };
  sess.nodes.set(id, node);
  sess.totalInputTokens += node.inputTokens;
  sess.totalOutputTokens += node.outputTokens;
  sess.lastActivity = Date.now();

  const resolvedParent = parentId === 'root' ? sess.rootId : parentId;
  if (resolvedParent && sess.nodes.has(resolvedParent)) {
    sess.nodes.get(resolvedParent).children.push(id);
    node.parentId = resolvedParent;
  }
}

function updateNode(sess, id, updates) {
  const node = sess.nodes.get(id);
  if (!node) return null;
  if (updates.label !== undefined) node.label = updates.label;
  if (updates.status !== undefined) node.status = updates.status;
  if (updates.detail !== undefined) node.detail = updates.detail;
  if (updates.inputTokens !== undefined) {
    sess.totalInputTokens += updates.inputTokens - node.inputTokens;
    node.inputTokens = updates.inputTokens;
  }
  if (updates.outputTokens !== undefined) {
    sess.totalOutputTokens += updates.outputTokens - node.outputTokens;
    node.outputTokens = updates.outputTokens;
  }
  sess.lastActivity = Date.now();
  return node;
}

function buildTree(sess) {
  if (!sess.rootId || !sess.nodes.has(sess.rootId)) return null;
  function build(id) {
    const n = sess.nodes.get(id);
    if (!n) return null;
    return {
      id: n.id, label: n.label, detail: n.detail, type: n.type,
      status: n.status, inputTokens: n.inputTokens, outputTokens: n.outputTokens,
      createdAt: n.createdAt, children: n.children.map(build).filter(Boolean)
    };
  }
  return build(sess.rootId);
}

function sessionSummaries() {
  return [...sessions.values()].map(s => ({
    sessionId: s.sessionId,
    label: s.label,
    model: s.model,
    nodeCount: s.nodes.size,
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    sessionStart: s.sessionStart,
    lastActivity: s.lastActivity,
    active: s.active
  })).sort((a, b) => b.lastActivity - a.lastActivity);
}

function stateMsg(sessionId) {
  const sess = sessions.get(sessionId);
  return {
    type: 'state',
    sessionId,
    model: sess?.model || null,
    tree: sess ? buildTree(sess) : null,
    totalInputTokens: sess?.totalInputTokens || 0,
    totalOutputTokens: sess?.totalOutputTokens || 0,
    nodeCount: sess?.nodes.size || 0,
    sessionStart: sess?.sessionStart || null,
    sessions: sessionSummaries()
  };
}

// ── WebSocket ─────────────────────────────────────────────────

// Map<ws, { subscribedSessionId: string|null }>
const wsClients = new Map();

function broadcast(changedSessionId) {
  const summaries = sessionSummaries();
  for (const [ws, info] of wsClients) {
    if (ws.readyState !== 1) continue;
    if (info.subscribedSessionId === changedSessionId) {
      ws.send(JSON.stringify(stateMsg(changedSessionId)));
    } else {
      // Keep every client's session list fresh
      ws.send(JSON.stringify({ type: 'sessions', sessions: summaries }));
    }
  }
}

// ── HTTP Server ───────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const httpServer = createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url.startsWith('/api/')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try { handleApi(url, req.method, body ? JSON.parse(body) : {}, res); }
      catch { res.writeHead(400); res.end('{"error":"bad json"}'); }
    });
    return;
  }

  const safePath = url.replace(/\.\./g, '');
  const filePath = join(__dirname, 'public', safePath === '/' ? 'index.html' : safePath);
  try {
    if (!existsSync(filePath)) throw new Error();
    const content = readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not Found');
  }
});

function ok(res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
}
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
}

function handleApi(url, method, data, res) {
  // GET /api/ping
  if (url === '/api/ping' && method === 'GET') return ok(res);

  // POST /api/sessions — register / re-activate
  if (url === '/api/sessions' && method === 'POST') {
    const { sessionId, pid } = data;
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, makeSession(sessionId, pid));
    } else {
      sessions.get(sessionId).active = true;
    }
    broadcast(sessionId);
    return ok(res);
  }

  // DELETE /api/sessions/:id — mark inactive
  const mDel = url.match(/^\/api\/sessions\/([^/]+)$/);
  if (mDel && method === 'DELETE') {
    const sess = sessions.get(mDel[1]);
    if (sess) { sess.active = false; broadcast(mDel[1]); }
    return ok(res);
  }

  // POST /api/sessions/:id/init
  const mInit = url.match(/^\/api\/sessions\/([^/]+)\/init$/);
  if (mInit && method === 'POST') {
    let sess = sessions.get(mInit[1]);
    if (!sess) { sess = makeSession(mInit[1]); sessions.set(mInit[1], sess); }
    resetSession(sess);
    sess.label = data.title || sess.label;
    sess.model = data.model || sess.model;
    sess.active = true;
    sess.rootId = 'root';
    addNode(sess, 'root', null, data.title, 'Session root', 'root', data.input_tokens || 0, data.output_tokens || 0);
    broadcast(mInit[1]);
    return ok(res);
  }

  // POST /api/sessions/:id/nodes
  const mNodes = url.match(/^\/api\/sessions\/([^/]+)\/nodes$/);
  if (mNodes && method === 'POST') {
    const sess = sessions.get(mNodes[1]);
    if (!sess) return notFound(res);
    addNode(sess, data.id, data.parent_id, data.label, data.detail, data.type, data.input_tokens, data.output_tokens);
    broadcast(mNodes[1]);
    return ok(res);
  }

  // PATCH /api/sessions/:id/nodes/:nodeId
  const mNode = url.match(/^\/api\/sessions\/([^/]+)\/nodes\/([^/]+)$/);
  if (mNode && method === 'PATCH') {
    const sess = sessions.get(mNode[1]);
    if (!sess) return notFound(res);
    updateNode(sess, mNode[2], {
      label: data.label, status: data.status, detail: data.detail,
      inputTokens: data.input_tokens, outputTokens: data.output_tokens
    });
    broadcast(mNode[1]);
    return ok(res);
  }

  // POST /api/sessions/:id/clear
  const mClear = url.match(/^\/api\/sessions\/([^/]+)\/clear$/);
  if (mClear && method === 'POST') {
    const sess = sessions.get(mClear[1]);
    if (sess) { resetSession(sess); broadcast(mClear[1]); }
    return ok(res);
  }

  notFound(res);
}

// ── WebSocket ─────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });
wss.on('error', () => {});

wss.on('connection', ws => {
  wsClients.set(ws, { subscribedSessionId: null });
  ws.send(JSON.stringify({ type: 'sessions', sessions: sessionSummaries() }));

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'subscribe' && msg.sessionId) {
        wsClients.set(ws, { subscribedSessionId: msg.sessionId });
        ws.send(JSON.stringify(stateMsg(msg.sessionId)));
      }
    } catch {}
  });

  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

// ── Start ─────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[claude-mindmap] Shared server at http://localhost:${PORT}`);
});

httpServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[claude-mindmap] Port ${PORT} already in use — is shared-server already running?`);
    process.exit(1);
  }
});
