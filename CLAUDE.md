# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ioBroker.xterm is an ioBroker adapter that provides a web-based multi-tab shell terminal (xterm.js + React) for executing commands on the ioBroker host. The adapter runs as a daemon, serving an Express/WebSocket server that connects a React frontend to real PTY shells via `node-pty`.

## Build & Development Commands

```bash
npm run build           # Build frontend (Vite) + backend (tsc)
npm run build:web       # Build React frontend only (src-web/ → public/)
npm run build:tsc       # Build TypeScript backend only (src/ → build/)
npm run dev:web         # Vite dev server with HMR for frontend
npm run lint            # ESLint check (backend only, src-web is excluded)
npm run test            # Package validation tests
npm run test:unit       # Unit tests (mocha)
npm run test:integration # Integration tests (mocha)
```

## Architecture

**Backend** (`src/main.ts`): Single-file adapter class `XtermAdapter` extending ioBroker's `Adapter`. Serves static files from `public/` via `express.static()` and manages WebSocket connections with multiplexed PTY sessions.

**Frontend** (`src-web/`): React + TypeScript app built with Vite to `public/`. Multi-tab terminal using xterm.js. Each tab has its own PTY process on the server.

**Multi-tab WebSocket protocol** — single connection, multiplexed by `tabId`:
- Client→Server: `{ method: "create", tabId }`, `{ method: "key", tabId, key }`, `{ method: "resize", tabId, cols, rows }`, `{ method: "close", tabId }`
- Server→Client: `{ method: "data", tabId, data }`, `{ method: "created", tabId }`, `{ method: "closed", tabId }`

**Authentication:** Basic HTTP auth against ioBroker's admin user, with brute-force protection (escalating delays) and a 10-second auth cache.

## Key Files

- `src/main.ts` — Backend: Express server, WebSocket handler, PTY management
- `src/types.d.ts` — `XtermAdapterConfig` interface
- `src-web/App.tsx` — Main React component: tab state, WebSocket integration, data routing
- `src-web/components/TerminalPane.tsx` — xterm.js terminal lifecycle per tab
- `src-web/components/TabBar.tsx` — Tab strip UI
- `src-web/components/SearchBar.tsx` — Ctrl+Shift+F search overlay
- `src-web/components/PasteDialog.tsx` — Ctrl+Shift+V paste modal
- `src-web/hooks/useWebSocket.ts` — WebSocket connection manager with auto-reconnect
- `src-web/theme.ts` — xterm.js dark theme constant
- `src-web/types.ts` — Protocol message types
- `src-web/vite.config.ts` — Vite build config (root: src-web, output: ../public)

## TypeScript

- Backend: ES2022, Node16 modules, strict mode. Source in `src/`, output in `build/`
- Frontend: ES2020, ESNext modules, react-jsx. Source in `src-web/`, output in `public/` (via Vite)
- Separate tsconfig files: `tsconfig.build.json` (backend), `src-web/tsconfig.json` (frontend)

## Testing

Tests use `@iobroker/testing` (wraps Mocha) and are plain JS files in `test/`. The test infrastructure validates package structure, adapter instantiation, and integration with ioBroker.

## ioBroker Adapter Conventions

- Adapter lifecycle: `onReady()` initializes the web server, `onUnload()` tears it down
- Connection state tracked via `info.connection` ioBroker state
- Config defined in `io-package.json` under `native` (bind, port, secure, auth)
- Default port: 8099
- Supports compact mode (shared process)
- `node-pty` is a required dependency
