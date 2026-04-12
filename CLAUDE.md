# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ioBroker.xterm is an ioBroker adapter that provides a web-based shell terminal (xterm.js) for executing commands on the ioBroker host. It replaces the legacy `ioBroker.terminal` adapter. The adapter runs as a daemon, serving an Express/WebSocket server that connects a browser-based xterm.js frontend to a real PTY shell via `node-pty`.

## Build & Development Commands

```bash
npm run build           # Compile TypeScript (src/ → build/)
npm run lint            # ESLint check
npm run test            # Package validation tests
npm run test:unit       # Unit tests (mocha)
npm run test:integration # Integration tests (mocha)
```

## Architecture

**Single-file adapter:** All server logic lives in `src/main.ts` — a class `XtermAdapter` extending ioBroker's `Adapter`. There is no multi-module backend structure.

**PTY-only terminal:** Spawns a real bash (Linux) or cmd.exe (Windows) via `node-pty`. All I/O is direct pass-through — the backend does no command parsing or simulation.

**Frontend:** `public/index.html` is a standalone HTML+JS file (no build step) using `@xterm/xterm` libraries served dynamically from node_modules. Features: dark theme, WebGL rendering, clickable URLs (web-links addon), Ctrl+Shift+F search, copy-on-select, right-click paste.

**WebSocket protocol:**
- Server→Client: `{ data }` (terminal output)
- Client→Server: `{ method: "key", key }` (keystrokes), `{ method: "resize", cols, rows }` (terminal resize)

**Authentication:** Basic HTTP auth against ioBroker's admin user, with brute-force protection (escalating delays) and a 10-second auth cache.

**Static file serving:** xterm library files are resolved dynamically from npm module paths at runtime (`require.resolve`), not copied or bundled.

## Key Files

- `src/main.ts` — All adapter/server logic
- `src/types.d.ts` — `XtermAdapterConfig` interface
- `public/index.html` — Frontend terminal UI (vanilla JS, no build)
- `admin/jsonConfig.json` — Adapter settings panel
- `io-package.json` — ioBroker adapter metadata and default config
- `tsconfig.build.json` — Build config (extends tsconfig.json, outputs CommonJS to `build/`)

## TypeScript

- Target: ES2022, Module: Node16, strict mode
- Source in `src/`, output in `build/`
- Only two source files: `main.ts` and `types.d.ts`

## Testing

Tests use `@iobroker/testing` (wraps Mocha) and are plain JS files in `test/`. The test infrastructure validates package structure, adapter instantiation, and integration with ioBroker.

## ioBroker Adapter Conventions

- Adapter lifecycle: `onReady()` initializes the web server, `onUnload()` tears it down
- Connection state tracked via `info.connection` ioBroker state
- Config defined in `io-package.json` under `native` (bind, port, secure, auth)
- Default port: 8099
- Supports compact mode (shared process)
- `node-pty` is a required dependency
