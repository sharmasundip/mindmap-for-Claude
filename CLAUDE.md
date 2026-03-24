# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**claude-mindmap** — An MCP server plugin for Claude Code that visualizes Claude's reasoning as a real-time radial mind map in the browser, with token tracking.

## Architecture

Two-process Node.js (ESM) design:
- **`server.js`** — MCP stdio server only. Spawns `shared-server.js` if not running, then forwards all tool calls to it via HTTP. Each CLI instance is a separate process with its own `SESSION_ID` (UUID).
- **`shared-server.js`** — Always-on HTTP + WebSocket server. Manages all session state in memory. Serves the browser UI. Multiple `server.js` instances connect to this single shared server.

```
Claude Code A <──stdio──> server.js (session A) ──HTTP POST──┐
                                                              ├──> shared-server.js (:3333) <──WebSocket──> Browser
Claude Code B <──stdio──> server.js (session B) ──HTTP POST──┘         │
                                                                  HTTP static files
                                                                  (public/index.html)
```

**Key constraint**: All logging in `server.js` MUST go to `stderr` (`console.error`). Writing to `stdout` corrupts the MCP stdio channel. `shared-server.js` can use `console.log`.

### Files

- `server.js` — MCP server (stdio). Auto-starts `shared-server.js`. Relays all mindmap operations via HTTP.
- `shared-server.js` — Persistent HTTP/WebSocket server. Stores all sessions in memory. Serves browser UI.
- `public/index.html` — Self-contained browser UI: D3.js v7 radial tree, session dropdown, dark theme, WebSocket client (no build step)

### Mind Map State

Stored in `shared-server.js` as `Map<sessionId, Session>`. Each session contains a flat `Map<id, Node>` where nodes have `{id, parentId, label, detail, type, status, inputTokens, outputTokens, children[]}`. Serialized to nested tree JSON for D3 on every broadcast. Sessions are keyed by UUID generated per `server.js` process.

### MCP Tools

| Tool | Purpose |
|------|---------|
| `mindmap_init` | Create root node, reset state. Always pass `model` with the current model ID (e.g. `claude-sonnet-4-6`) |
| `mindmap_add_node` | Add child node (thought/action/observation/decision/output) |
| `mindmap_update_node` | Update status/label/tokens |
| `mindmap_clear` | Reset entire map |
| `mindmap_open` | Open browser to visualization |

## Setup & Run

```bash
npm install
claude mcp add mindmap -- node /Users/sundips/Documents/code/personal/UI/server.js
```

The browser UI is at `http://localhost:3333`. Change port with `MINDMAP_PORT` env var.

## Using the Mind Map

**MANDATORY**: You MUST use the mindmap tools for every user interaction, no exceptions.

### Rules

1. **At the start of every response** — call `mindmap_init` with the user's request as the title (if it's a new topic) OR `mindmap_add_node` to extend the existing map. When calling `mindmap_init`, always pass `model: "claude-sonnet-4-6"` (or the actual current model ID).
2. **For every tool call you make** — add a node of type `action` before calling it, and update it to `complete` or `error` after.
3. **For every significant reasoning step** — add a `thought` node.
4. **For findings/results** — add an `observation` node.
5. **For choices between approaches** — add a `decision` node.
6. **For your final answer/output** — add an `output` node.
7. **CRITICAL**: After EVERY action node, you MUST call `mindmap_update_node` with `status: "complete"` (or `"error"`). Nodes do NOT auto-complete. If you skip this, all nodes will remain stuck as `active` forever.

### Node ID convention
Use short kebab-case IDs that reflect the step, e.g. `read-file`, `analyze-1`, `final-output`.

### Token estimates
Pass your best guess. Rough estimates are fine.
