# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ioBroker.xterm is an ioBroker adapter that provides a web-based multi-tab shell terminal (xterm.js + React) for executing commands on the ioBroker host. The adapter runs as a daemon, serving an Express/WebSocket server that connects a React frontend to real PTY shells via `node-pty`.

## Build & Development Commands

```bash
npm run build           # Full build: backend (tsc) then frontend (cd src-web && npm install && vite build)
npm run build:tsc       # Build TypeScript backend only (src/ → build/)
npm run lint            # ESLint check (backend src/ only; src-web, test, build, admin are ignored)
npm run test            # Package validation tests (alias for test:package)
npm run test:unit       # Unit tests (mocha)
npm run test:integration # Integration tests (mocha)
```

Frontend-only commands live in `src-web/package.json` and must be run from `src-web/`:

```bash
cd src-web
npm install
npm run build           # Vite build → ../public
npm start               # Vite dev server (vite --host); proxies /ws → ws://localhost:8099
npm run lint            # ESLint for the frontend
```

There is no root `build:web` / `dev:web` script. To develop the UI live, run the adapter (backend WebSocket server on port 8099) and `npm start` in `src-web/` separately — the dev server proxies WebSocket traffic to the running backend.

## Architecture

**Backend** (`src/main.ts`): Single-file adapter class `XtermAdapter` extending ioBroker's `Adapter`. The HTTP(S) server is created via `@iobroker/webserver`'s `WebServer` (handles certificates when `secure`), wrapping an Express app that serves static files from the repo-root `public/` (`express.static`) with an SPA fallback to `public/index.html`. WebSocket upgrades are handled manually on the `server.upgrade` event and routed to a `noServer` `WebSocketServer`.

**Frontend** (`src-web/src/`): React 19 + TypeScript app built with Vite to the repo-root `public/`. Multi-tab terminal using xterm.js. Each tab has its own PTY process on the server. Entry point is `src-web/src/main.tsx`.

**PTY / shell selection** (`startShellForTab`): per `tabId`, `node-pty` spawns `cmd.exe` on Windows, `su - <shellUser>` when `shellUser` is configured on Linux, otherwise `bash`. Working directory is `config.cwd` or, if empty, the detected ioBroker root. A PTY that exits is automatically restarted while its tab is still open.

**Multi-tab WebSocket protocol** — single connection, multiplexed by `tabId`:
- Client→Server: `{ method: "create", tabId }`, `{ method: "key", tabId, key }`, `{ method: "resize", tabId, cols, rows }`, `{ method: "close", tabId }`
- Server→Client: `{ method: "data", tabId, data }`, `{ method: "created", tabId }`, `{ method: "closed", tabId }`

**Authentication** (only when `config.auth`, hardcoded to the ioBroker `admin` user via `checkPassword`, with shared brute-force protection — escalating lockout delays after 4 failures). Two modes selected by `config.authType`:
- `basic`: HTTP Basic auth Express middleware, backed by a 10-second auth cache. The WebSocket upgrade re-runs the same Basic check.
- `digest`: session-cookie login instead — serves a `/login` page, `POST /api/login` / `POST /api/logout` endpoints, and issues an HMAC-signed `xterm_session` cookie (24h expiry, secret regenerated each process start). A middleware redirects unauthenticated page requests to `/login`; the WebSocket upgrade verifies the cookie.

## Key Files

- `src/main.ts` — Backend: web server, auth, WebSocket handler, PTY management
- `src/types.d.ts` — `XtermAdapterConfig` interface
- `src-web/src/main.tsx` — Frontend entry point (mounts `App`)
- `src-web/src/App.tsx` — Main React component: tab state, WebSocket integration, data routing
- `src-web/src/components/TerminalPane.tsx` — xterm.js terminal lifecycle per tab
- `src-web/src/components/TabBar.tsx` — Tab strip UI
- `src-web/src/components/SearchBar.tsx` — Ctrl+Shift+F search overlay
- `src-web/src/components/PasteDialog.tsx` — Ctrl+Shift+V paste modal
- `src-web/src/hooks/useWebSocket.ts` — WebSocket connection manager with auto-reconnect
- `src-web/src/theme.ts` — xterm.js dark theme constant
- `src-web/src/types.ts` — Protocol message types
- `src-web/vite.config.ts` — Vite build config (root: `src-web/`, output: `../public`)
- `admin/jsonConfig.json` — Admin config UI schema (bind, port, secure, auth, authType, cwd, shellUser)

## TypeScript

- Backend: ES2022, Node16 modules, strict mode. Source in `src/`, output in `build/`
- Frontend: ES2020, ESNext modules, `bundler` resolution, react-jsx, `noEmit` (Vite does the emit). Source in `src-web/src/`, output in `public/`
- Separate tsconfig files: `tsconfig.json` (base + backend type-check), `tsconfig.build.json` (backend emit), `src-web/tsconfig.json` (frontend)

## Testing

Tests use `@iobroker/testing` (wraps Mocha) and are plain JS files in `test/`. The test infrastructure validates package structure, adapter instantiation, and integration with ioBroker.

## ioBroker Adapter Conventions

- Adapter lifecycle: `onReady()` initializes the web server, `onUnload()` tears it down
- Connection state tracked via the `info.connection` ioBroker state (holds the comma-separated list of connected client IPs, or `none`)
- Config defined in `io-package.json` under `native` (bind, port, secure, auth, authType, cwd, shellUser) and surfaced in the admin UI via `admin/jsonConfig.json`
- Default port: 8099 (set `findNextPort` to fall back to the next free port instead of terminating when the port is taken)
- Supports compact mode (shared process)
- `node-pty` is a required dependency
