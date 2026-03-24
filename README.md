# claude-mindmap

Real-time mind map visualization of Claude's reasoning process. Watch Claude think as a radial tree that grows live in your browser, complete with token tracking.

![Mind Map Visualization](mindmap-complete.png)

## What is this?

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that visualizes Claude's reasoning as an interactive radial mind map in the browser. Every thought, action, decision, and observation becomes a node in the tree — updated in real time via WebSocket.

### Features

- Live radial mind map powered by D3.js
- Token usage tracking per node and per session
- Multi-session support — run multiple Claude Code instances simultaneously
- Dark theme UI with smooth animations
- No build step — single self-contained HTML file
- Auto-starts the visualization server on first use

## Prerequisites

- **Node.js** v18 or later
- **Claude Code** CLI ([install guide](https://docs.anthropic.com/en/docs/claude-code/getting-started))

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/sharmasundip/mindmap-for-Claude.git
cd claude-mindmap
```

### 2. Install dependencies

```bash
npm install
```

### 3. Register the MCP server with Claude Code

```bash
claude mcp add mindmap -- node /absolute/path/to/claude-mindmap/server.js
```

> **Important**: Use the full absolute path to `server.js`. For example:
> ```bash
> claude mcp add mindmap -- node /Users/yourname/projects/claude-mindmap/server.js
> ```

That's it. The plugin is now registered and will be available in all Claude Code sessions.

## Usage

### 1. Start Claude Code

```bash
claude
```

### 2. Open the mind map in your browser

Navigate to **http://localhost:7788** in your browser, or ask Claude to open it:

> "Open the mind map"

The visualization server starts automatically when Claude first uses a mindmap tool — no manual server start needed.

### 3. Ask Claude anything

As Claude works through your request, you'll see the mind map grow in real time:

| Before | After |
|--------|-------|
| ![Before](mindmap-before.png) | ![After](mindmap-after.png) |

### 4. Instruct Claude to use the mind map

Add the following to your project's `CLAUDE.md` file (or `~/.claude/CLAUDE.md` for global use) to have Claude automatically use the mind map for every interaction:

```markdown
## Using the Mind Map

**MANDATORY**: You MUST use the mindmap tools for every user interaction, no exceptions.

### Rules

1. **At the start of every response** — call `mindmap_init` with the user's request as the title (if it's a new topic) OR `mindmap_add_node` to extend the existing map. When calling `mindmap_init`, always pass `model` with the current model ID.
2. **For every tool call you make** — add a node of type `action` before calling it, and update it to `complete` or `error` after.
3. **For every significant reasoning step** — add a `thought` node.
4. **For findings/results** — add an `observation` node.
5. **For choices between approaches** — add a `decision` node.
6. **For your final answer/output** — add an `output` node.
7. **CRITICAL**: After EVERY action node, you MUST call `mindmap_update_node` with `status: "complete"` (or `"error"`). Nodes do NOT auto-complete.
```

## Configuration

### Custom port

Set the `MINDMAP_PORT` environment variable to change the default port (7788):

```bash
MINDMAP_PORT=4000 claude
```

Or register the MCP server with the port baked in:

```bash
claude mcp add mindmap -e MINDMAP_PORT=4000 -- node /absolute/path/to/claude-mindmap/server.js
```

## Architecture

Two-process design for reliability:

```
Claude Code A <──stdio──> server.js (session A) ──HTTP──┐
                                                         ├──> shared-server.js (:7788) <──WS──> Browser
Claude Code B <──stdio──> server.js (session B) ──HTTP──┘         │
                                                             static files
                                                           (public/index.html)
```

- **`server.js`** — MCP stdio server. One per Claude Code instance. Auto-spawns the shared server if it isn't running, then relays all tool calls via HTTP.
- **`shared-server.js`** — Persistent HTTP + WebSocket server. Manages all session state in memory. Serves the browser UI. Shared across all Claude Code instances.
- **`public/index.html`** — Self-contained browser UI (D3.js v7, no build step).

## MCP Tools

| Tool | Purpose |
|------|---------|
| `mindmap_init` | Create root node and reset the map for a new topic |
| `mindmap_add_node` | Add a child node (thought / action / observation / decision / output) |
| `mindmap_update_node` | Update a node's status, label, or token counts |
| `mindmap_clear` | Reset the entire map |
| `mindmap_open` | Open the browser to the visualization URL |

## Troubleshooting

### Mind map not updating

- Check that the browser is connected at http://localhost:7788
- Verify the MCP server is registered: `claude mcp list`
- Check if the shared server is running: `curl http://localhost:7788/api/ping`

### Port already in use

- Kill the existing shared server: `lsof -ti:7788 | xargs kill`
- Or use a different port via `MINDMAP_PORT`

### MCP server not found

- Ensure you used an absolute path when registering: `claude mcp add mindmap -- node /absolute/path/to/server.js`
- Re-register if you moved the project directory

## Uninstalling

```bash
claude mcp remove mindmap
```

## License

MIT
