import { Adapter, type AdapterOptions, EXIT_CODES, getAbsoluteDefaultDataDir } from '@iobroker/adapter-core';
import { WebServer as IoBWebServer } from '@iobroker/webserver';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import * as pty from 'node-pty';
import type { Socket, AddressInfo } from 'node:net';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';

import type { XtermAdapterConfig } from './types';

interface IobrokerMeta {
    address: string;
    /** IDs of the terminal sessions that are attached to this connection */
    sessions: Set<string>;
}

/**
 * A terminal session lives in the adapter and not in the web socket connection,
 * so the shell survives a reconnection of the browser.
 */
interface TerminalSession {
    id: string;
    pty: pty.IPty | null;
    /** Last output of the shell, used to restore the terminal after a reconnection */
    buffer: string;
    /** Currently attached web socket or null if no client is connected */
    ws: XtermWebSocket | null;
    /** Terminates the session if no client comes back */
    killTimer: ReturnType<typeof setTimeout> | null;
    /** Delayed restart of a shell that exited immediately */
    restartTimer: ReturnType<typeof setTimeout> | null;
    /** Number of consecutive immediate exits of the shell */
    restarts: number;
    /** Time when the last client detached */
    detachedAt: number;
    cols: number;
    rows: number;
}

interface XtermWebSocket extends WebSocket {
    __iobroker?: IobrokerMeta;
    _socket: Socket & { ___auth?: boolean };
}

interface WebServerInstance {
    app: express.Express | null;
    server: HttpServer | HttpsServer | null;
    io: WebSocketServer | null;
    settings: XtermAdapterConfig;
}

interface BruteForceEntry {
    errors: number;
    time: number;
}

interface AuthCache {
    data: string;
    ts: number;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!cookieHeader) {
        return cookies;
    }
    for (const pair of cookieHeader.split(';')) {
        const idx = pair.indexOf('=');
        if (idx > 0) {
            const value = pair.substring(idx + 1).trim();
            let decoded: string;
            try {
                // Express' res.cookie URL-encodes the value (e.g. base64 "==" → "%3D%3D"), so decode it back
                decoded = decodeURIComponent(value);
            } catch {
                decoded = value;
            }
            cookies[pair.substring(0, idx).trim()] = decoded;
        }
    }
    return cookies;
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>xterm - Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1e1e1e;color:#ccc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh}
.login-box{background:#252526;border:1px solid #3c3c3c;border-radius:8px;padding:2rem;width:340px;box-shadow:0 8px 32px rgba(0,0,0,.4)}
h2{text-align:center;margin-bottom:1.5rem;color:#fff;font-weight:500}
.form-group{margin-bottom:1rem}
label{display:block;margin-bottom:.4rem;font-size:.85rem;color:#999}
input{width:100%;padding:.55rem .75rem;background:#1e1e1e;border:1px solid #3c3c3c;border-radius:4px;color:#ccc;font-size:.95rem;outline:none;transition:border-color .2s}
input:focus{border-color:#007acc}
button{width:100%;padding:.6rem;margin-top:.5rem;background:#007acc;border:none;border-radius:4px;color:#fff;font-size:.95rem;cursor:pointer;transition:background .2s}
button:hover{background:#005fa3}
button:disabled{background:#555;cursor:not-allowed}
.error{background:rgba(244,71,71,.1);border:1px solid #f44747;border-radius:4px;padding:.5rem .75rem;margin-bottom:1rem;font-size:.85rem;color:#f44747;display:none}
</style>
</head>
<body>
<div class="login-box">
<h2>xterm Login</h2>
<div class="error" id="error"></div>
<form id="loginForm">
<div class="form-group"><label for="username">Username</label><input type="text" id="username" name="username" autocomplete="username" required autofocus></div>
<div class="form-group"><label for="password">Password</label><input type="password" id="password" name="password" autocomplete="current-password" required></div>
<button type="submit" id="submitBtn">Login</button>
</form>
</div>
<script>
document.getElementById("loginForm").addEventListener("submit",function(e){
e.preventDefault();
var err=document.getElementById("error"),btn=document.getElementById("submitBtn");
err.style.display="none";btn.disabled=true;btn.textContent="Logging in\\u2026";
fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:document.getElementById("username").value,password:document.getElementById("password").value})}).then(function(r){if(r.ok){window.location.href="/"}else{return r.json().then(function(d){err.textContent=d.error||"Login failed";err.style.display="block"})}}).catch(function(){err.textContent="Connection error";err.style.display="block"}).finally(function(){btn.disabled=false;btn.textContent="Login"});
});
</script>
</body>
</html>`;

/** Maximum number of simultaneously existing terminal sessions */
const MAX_SESSIONS = 20;
/** A shell that exits faster than that is treated as "failed to start" */
const MIN_SHELL_LIFETIME_MS = 2000;
/** How many times a failing shell will be restarted before giving up */
const MAX_SHELL_RESTARTS = 5;
/** How many characters of the shell output are kept to restore the terminal after a reconnection */
const REPLAY_BUFFER_SIZE = 100000;
/** Used if the configured session timeout is invalid */
const DEFAULT_SESSION_TIMEOUT_MIN = 5;

function findIoBrokerDirectory(): string {
    const dir = getAbsoluteDefaultDataDir().replace(/\\/g, '/');
    const parts = dir.split('/');
    parts.pop();
    parts.pop();
    return parts.join('/');
}

class XtermAdapter extends Adapter {
    declare config: XtermAdapterConfig;

    private server: WebServerInstance | null = null;
    /** All terminal sessions, independent of the web socket connections */
    private sessions: Map<string, TerminalSession> = new Map();
    private connectedIPs: string[] = [];
    private bruteForce: Record<string, BruteForceEntry> = {};
    private IOB_DIR: string = findIoBrokerDirectory();
    private cache: AuthCache | null = null;
    private sessionSecret: string = crypto.randomBytes(32).toString('hex');

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({
            ...options,
            name: 'xterm',
            ready: (): void => {
                void this.onReady();
            },
            unload: (callback): void => {
                this.onUnload(callback);
            },
        });
    }

    private onUnload(callback: () => void): void {
        try {
            // Terminate all shells, so no orphaned processes stay behind
            this.destroyAllSessions();

            if (this.server?.io) {
                this.server.io.clients.forEach(socket => socket.close());
            }

            setTimeout(() => {
                if (this.server?.io) {
                    this.server.io.clients.forEach(socket => {
                        if (socket.readyState === socket.OPEN || socket.readyState === socket.CLOSING) {
                            socket.terminate();
                        }
                    });
                    try {
                        this.server.io.close();
                    } catch {
                        // ignore
                    }
                }

                try {
                    this.server?.server?.close();
                } catch {
                    // ignore
                }

                void this.setStateChangedAsync('info.connection', '', true).then(() => callback());
            }, 300);
        } catch {
            void this.setStateChangedAsync('info.connection', '', true).then(() => callback());
        }
    }

    private async onReady(): Promise<void> {
        const obj = await this.getObjectAsync('info.connection');
        if (obj && obj.common.type !== 'string') {
            obj.common.type = 'string';
            await this.setObjectAsync(obj._id, obj);
        }

        await this.setStateChangedAsync('info.connection', '', true);
        this.server = this.initWebServer(this.config);
        await this.setStateChangedAsync('info.connection', 'none', true);
    }

    private createSessionToken(username: string): string {
        const expiry = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
        const payload = `${username}:${expiry}`;
        const sig = crypto.createHmac('sha256', this.sessionSecret).update(payload).digest('hex');
        return `${Buffer.from(payload).toString('base64')}.${sig}`;
    }

    private verifySessionToken(token: string): string | null {
        const dotIndex = token.indexOf('.');
        if (dotIndex === -1) {
            return null;
        }
        const payloadB64 = token.substring(0, dotIndex);
        const sig = token.substring(dotIndex + 1);

        let payload: string;
        try {
            payload = Buffer.from(payloadB64, 'base64').toString();
        } catch {
            return null;
        }

        const expected = crypto.createHmac('sha256', this.sessionSecret).update(payload).digest('hex');
        if (sig.length !== expected.length) {
            return null;
        }
        if (!crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
            return null;
        }

        const colonIndex = payload.indexOf(':');
        if (colonIndex === -1) {
            return null;
        }
        const username = payload.substring(0, colonIndex);
        const expiry = parseInt(payload.substring(colonIndex + 1), 10);
        if (isNaN(expiry) || Date.now() > expiry) {
            return null;
        }

        return username;
    }

    private getBruteForceDelay(username: string): string | null {
        if (!this.bruteForce[username] || this.bruteForce[username].errors <= 4) {
            return null;
        }

        let minutes: number = Date.now() - this.bruteForce[username].time;
        if (this.bruteForce[username].errors < 7) {
            if (Date.now() - this.bruteForce[username].time < 60000) {
                minutes = 1;
            } else {
                minutes = 0;
            }
        } else if (this.bruteForce[username].errors < 10) {
            if (Date.now() - this.bruteForce[username].time < 180000) {
                minutes = Math.ceil((180000 - minutes) / 60000);
            } else {
                minutes = 0;
            }
        } else if (this.bruteForce[username].errors < 15) {
            if (Date.now() - this.bruteForce[username].time < 600000) {
                minutes = Math.ceil((600000 - minutes) / 60000);
            } else {
                minutes = 0;
            }
        } else if (Date.now() - this.bruteForce[username].time < 3600000) {
            minutes = Math.ceil((3600000 - minutes) / 60000);
        } else {
            minutes = 0;
        }

        if (minutes) {
            return `Too many errors. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
        }
        return null;
    }

    private auth(req: IncomingMessage, callback: (result: boolean, text?: string) => void): void {
        const str = (req.headers.Authorization || req.headers.authorization) as string;
        if (this.cache && Date.now() - this.cache.ts < 10000 && this.cache.data === str) {
            return callback(true);
        }
        if (!str || !str.startsWith('Basic ')) {
            this.cache = null;
            return callback(false);
        }
        const data = Buffer.from(str.substring(6), 'base64').toString();
        const [username, password] = data.split(':');

        if (username !== 'admin' || !password) {
            this.cache = null;
            return callback(false);
        }

        const bruteForceMsg = this.getBruteForceDelay(username);
        if (bruteForceMsg) {
            return callback(false, bruteForceMsg);
        }

        void this.checkPassword(username, password, result => {
            if (result) {
                this.cache = { data: str, ts: Date.now() };
                if (this.bruteForce[username]) {
                    delete this.bruteForce[username];
                }
            } else {
                this.cache = null;
                this.bruteForce[username] = this.bruteForce[username] || { errors: 0, time: 0 };
                this.bruteForce[username].time = Date.now();
                this.bruteForce[username].errors++;
            }

            callback(result);
        });
    }

    private verifySessionCookie(req: IncomingMessage): boolean {
        const cookies = parseCookies(req.headers.cookie);
        const token = cookies.xterm_session;
        return !!(token && this.verifySessionToken(token));
    }

    /** Send a message to the client, but only if the socket is still open */
    private sendToClient(ws: XtermWebSocket, message: Record<string, unknown>): void {
        if (ws.readyState !== ws.OPEN) {
            return;
        }
        try {
            ws.send(JSON.stringify(message));
        } catch (err) {
            this.log.debug(`Cannot send message to client: ${err as Error}`);
        }
    }

    /** Determine the working directory of the shell and fall back to the ioBroker directory if it does not exist */
    private getShellCwd(): string {
        if (this.config.cwd) {
            if (fs.existsSync(this.config.cwd)) {
                return this.config.cwd;
            }
            this.log.warn(`Start directory "${this.config.cwd}" does not exist. Using "${this.IOB_DIR}" instead.`);
        }
        return this.IOB_DIR;
    }

    /** How long a session stays alive without a client (in ms, 0 = terminate immediately) */
    private getSessionTimeout(): number {
        const minutes = Number(this.config.sessionTimeout);
        return (isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_SESSION_TIMEOUT_MIN) * 60000;
    }

    /** Shell and its arguments for the current configuration */
    private getShell(): { shell: string; args: string[] } {
        if (os.platform() === 'win32') {
            return { shell: 'cmd.exe', args: [] };
        }
        if (this.config.shellUser) {
            return { shell: 'su', args: ['-', this.config.shellUser] };
        }
        return { shell: 'bash', args: [] };
    }

    /** Store the output of the shell, so the terminal can be restored after a reconnection */
    private static appendToBuffer(session: TerminalSession, data: string): void {
        session.buffer += data;
        if (session.buffer.length > REPLAY_BUFFER_SIZE) {
            const cut = session.buffer.length - REPLAY_BUFFER_SIZE;
            // Cut at a line break, so no escape sequence is torn apart
            const lineStart = session.buffer.indexOf('\n', cut);
            session.buffer = session.buffer.substring(lineStart === -1 ? cut : lineStart + 1);
        }
    }

    /** Start the shell of a session. Returns false if the shell could not be started at all */
    private startPty(session: TerminalSession): boolean {
        const { shell, args } = this.getShell();

        let ptyProcess: pty.IPty;
        try {
            ptyProcess = pty.spawn(shell, args, {
                name: 'xterm-256color',
                cols: session.cols,
                rows: session.rows,
                cwd: this.getShellCwd(),
                env: process.env,
            });
        } catch (err) {
            // e.g. shell not found or no rights for the working directory
            this.log.error(`Cannot start shell "${shell}": ${err as Error}`);
            this.sendToSession(session, {
                method: 'data',
                tabId: session.id,
                data: `\r\n\x1b[31mCannot start shell "${shell}": ${(err as Error).message}\x1b[0m\r\n`,
            });
            return false;
        }

        const startedAt = Date.now();
        session.pty = ptyProcess;

        ptyProcess.onData((data: string) => {
            XtermAdapter.appendToBuffer(session, data);
            this.sendToSession(session, { method: 'data', tabId: session.id, data });
        });

        // Restart the shell of the session, but do not leave a session without a shell behind
        const restartShell = (): void => {
            if (this.sessions.get(session.id) === session && !this.startPty(session)) {
                this.terminateSession(session, false);
            }
        };

        ptyProcess.onExit(({ exitCode, signal }) => {
            // Ignore PTYs that were already replaced or belong to a destroyed session
            if (session.pty !== ptyProcess || this.sessions.get(session.id) !== session) {
                return;
            }
            session.pty = null;

            // If the shell dies immediately (invalid user, missing shell, ...), do not restart it endlessly
            if (Date.now() - startedAt >= MIN_SHELL_LIFETIME_MS) {
                session.restarts = 0;
                restartShell();
                return;
            }

            session.restarts++;
            if (session.restarts > MAX_SHELL_RESTARTS) {
                this.log.error(
                    `Shell "${shell}" terminates immediately (code: ${exitCode}, signal: ${signal ?? '-'}). Giving up.`,
                );
                this.sendToSession(session, {
                    method: 'data',
                    tabId: session.id,
                    data:
                        `\r\n\x1b[31mThe shell "${shell}" terminates immediately (code ${exitCode}).\x1b[0m\r\n` +
                        `\x1b[31mPlease check the adapter settings (start directory, shell user).\x1b[0m\r\n`,
                });
                this.terminateSession(session, false);
                return;
            }

            session.restartTimer = setTimeout(() => {
                session.restartTimer = null;
                restartShell();
            }, 1000);
        });

        return true;
    }

    /** Send a message to the client that is currently attached to the session */
    private sendToSession(session: TerminalSession, message: Record<string, unknown>): void {
        if (session.ws) {
            this.sendToClient(session.ws, message);
        }
    }

    /**
     * Attach a connection to an existing session or create a new one.
     * That is what makes the shell survive a reload or a lost connection.
     */
    private attachSession(ws: XtermWebSocket, tabId: string): void {
        if (!ws.__iobroker || ws.readyState !== ws.OPEN) {
            return;
        }

        let session = this.sessions.get(tabId);
        const restored = !!session;

        if (session) {
            // The session is taken over by this connection
            if (session.ws && session.ws !== ws) {
                this.log.debug(`Terminal ${tabId} was taken over by another connection`);
                // Tell the old client why its terminal does not react anymore
                this.sendToClient(session.ws, {
                    method: 'data',
                    tabId,
                    data: '\r\n\x1b[33mThis terminal was taken over by another connection.\x1b[0m\r\n',
                });
                session.ws.__iobroker?.sessions.delete(tabId);
            }
            if (session.killTimer) {
                clearTimeout(session.killTimer);
                session.killTimer = null;
            }
        } else {
            if (!this.makeRoomForSession()) {
                this.log.warn(`Not more than ${MAX_SESSIONS} terminals are possible`);
                this.sendToClient(ws, {
                    method: 'data',
                    tabId,
                    data: `\r\n\x1b[31mToo many open terminals (max. ${MAX_SESSIONS}).\x1b[0m\r\n`,
                });
                return;
            }

            session = {
                id: tabId,
                pty: null,
                buffer: '',
                ws,
                killTimer: null,
                restartTimer: null,
                restarts: 0,
                detachedAt: 0,
                cols: 80,
                rows: 30,
            };
            this.sessions.set(tabId, session);

            if (!this.startPty(session)) {
                this.sessions.delete(tabId);
                return;
            }
        }

        session.ws = ws;
        ws.__iobroker.sessions.add(tabId);

        this.sendToClient(ws, { method: 'created', tabId, restored });

        if (restored && session.buffer) {
            // Let the client rebuild the terminal content
            this.sendToClient(ws, { method: 'restore', tabId, data: session.buffer });
        }
    }

    /** Terminate a session including its shell */
    private terminateSession(session: TerminalSession, notifyClient: boolean): void {
        this.sessions.delete(session.id);

        if (session.killTimer) {
            clearTimeout(session.killTimer);
            session.killTimer = null;
        }
        if (session.restartTimer) {
            clearTimeout(session.restartTimer);
            session.restartTimer = null;
        }

        const ptyProcess = session.pty;
        session.pty = null;
        if (ptyProcess) {
            try {
                ptyProcess.kill();
            } catch {
                // ignore
            }
        }

        if (session.ws) {
            session.ws.__iobroker?.sessions.delete(session.id);
            if (notifyClient) {
                this.sendToClient(session.ws, { method: 'closed', tabId: session.id });
            }
            session.ws = null;
        }
        session.buffer = '';
    }

    /** Detach all sessions of a connection and let them run until the timeout expires */
    private detachSocket(ws: XtermWebSocket): void {
        if (!ws.__iobroker) {
            return;
        }
        const timeout = this.getSessionTimeout();

        for (const id of ws.__iobroker.sessions) {
            const session = this.sessions.get(id);
            if (!session || session.ws !== ws) {
                // Already taken over by another connection
                continue;
            }
            session.ws = null;
            session.detachedAt = Date.now();

            if (!timeout) {
                this.terminateSession(session, false);
            } else {
                session.killTimer = setTimeout(() => {
                    session.killTimer = null;
                    this.log.debug(`Terminal ${id} terminated, because no client came back`);
                    this.terminateSession(session, false);
                }, timeout);
            }
        }
        ws.__iobroker.sessions.clear();
    }

    /** Make sure that a new session can be created. Detached sessions are sacrificed first */
    private makeRoomForSession(): boolean {
        if (this.sessions.size < MAX_SESSIONS) {
            return true;
        }
        let oldest: TerminalSession | null = null;
        for (const session of this.sessions.values()) {
            if (!session.ws && (!oldest || session.detachedAt < oldest.detachedAt)) {
                oldest = session;
            }
        }
        if (oldest) {
            this.log.debug(`Terminal ${oldest.id} terminated to make room for a new one`);
            this.terminateSession(oldest, false);
            return true;
        }
        return false;
    }

    /** Terminate all sessions, e.g. if the adapter stops */
    private destroyAllSessions(): void {
        for (const session of [...this.sessions.values()]) {
            this.terminateSession(session, false);
        }
    }

    /** Report the currently connected clients in `info.connection` */
    private updateConnectionState(): void {
        void this.setStateAsync('info.connection', [...new Set(this.connectedIPs)].join(', ') || 'none', true);
    }

    private initSocketConnection(ws: XtermWebSocket): void {
        // Without an error handler, a socket error (e.g. ECONNRESET or an invalid frame) would
        // be thrown as an uncaught exception and would terminate the adapter
        ws.on('error', (err: Error) => this.log.debug(`WebSocket error: ${err.message}`));

        if (this.config.auth && !ws._socket.___auth) {
            ws.close();
            this.log.error('Cannot establish socket connection as no credentials found!');
            return;
        }

        ws.__iobroker = {
            // `address()` would return the address of the server, not the one of the client
            address: ws._socket.remoteAddress || (ws._socket.address() as AddressInfo)?.address || 'unknown',
            sessions: new Set(),
        };

        this.connectedIPs.push(ws.__iobroker.address);
        this.updateConnectionState();

        ws.on('message', (rawMessage: Buffer | string) => {
            if (!ws.__iobroker) {
                return;
            }

            let message: { method?: string; tabId?: string; key?: string; cols?: number; rows?: number };
            try {
                message = JSON.parse(rawMessage.toString());
            } catch {
                this.log.warn('Received invalid JSON message from client');
                return;
            }

            if (!message || typeof message.tabId !== 'string' || !message.tabId) {
                return;
            }
            const tabId = message.tabId;

            if (message.method === 'create') {
                // Attaches to an existing session or creates a new one
                this.attachSession(ws, tabId);
                return;
            }

            // All other commands are only allowed for sessions of this connection
            const session = this.sessions.get(tabId);
            if (!session || session.ws !== ws) {
                return;
            }

            if (message.method === 'key') {
                if (typeof message.key === 'string') {
                    session.pty?.write(message.key);
                }
            } else if (message.method === 'resize') {
                const cols = Math.round(message.cols as number);
                const rows = Math.round(message.rows as number);
                // node-pty throws on invalid dimensions
                if (cols > 0 && rows > 0 && isFinite(cols) && isFinite(rows)) {
                    session.cols = cols;
                    session.rows = rows;
                    try {
                        session.pty?.resize(cols, rows);
                    } catch (err) {
                        this.log.debug(`Cannot resize terminal: ${err as Error}`);
                    }
                }
            } else if (message.method === 'close') {
                // Explicitly closed by the user => the session must not survive
                this.terminateSession(session, true);
            }
        });

        ws.on('close', () => {
            if (ws.__iobroker) {
                // The shells keep running, so the client can attach to them again
                this.detachSocket(ws);

                const pos = this.connectedIPs.indexOf(ws.__iobroker.address);
                if (pos !== -1) {
                    this.connectedIPs.splice(pos, 1);
                }
                delete ws.__iobroker;
            }
            this.log.debug('WebSocket connection disconnected');
            this.updateConnectionState();
        });

        this.log.debug('WebSocket connection established');
    }

    private initWebServer(settings: XtermAdapterConfig): WebServerInstance | null {
        const serverObj: WebServerInstance = {
            app: null,
            server: null,
            io: null,
            settings,
        };

        settings.port = parseInt(settings.port as unknown as string, 10) || 8099;

        if (!settings.port) {
            this.log.error('port missing');
            if (this.terminate) {
                this.terminate(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
            } else {
                process.exit(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
            }
            return null;
        }

        // The certificates for the secure mode are read by the ioBroker web server itself

        this.getPort(
            settings.port,
            !settings.bind || settings.bind === '0.0.0.0' ? undefined : settings.bind || undefined,
            async (port: number) => {
                if (port !== settings.port && !this.config.findNextPort) {
                    this.log.error(`port ${settings.port} already in use`);
                    if (this.terminate) {
                        this.terminate(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                    } else {
                        process.exit(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                    }
                    return;
                }

                settings.port = port;

                serverObj.app = express();

                if (this.config.auth && this.config.authType === 'digest') {
                    // Digest auth mode: session-based auth with login page
                    serverObj.app.use('/api', express.json());

                    serverObj.app.get('/login', (_req: express.Request, res: express.Response) => {
                        res.type('html').send(LOGIN_PAGE);
                    });

                    serverObj.app.post('/api/login', (req: express.Request, res: express.Response) => {
                        const { username, password } = req.body || {};
                        if (!username || !password) {
                            res.status(400).json({ error: 'Missing credentials' });
                            return;
                        }
                        if (username !== 'admin') {
                            res.status(401).json({ error: 'Invalid credentials' });
                            return;
                        }

                        const bruteForceMsg = this.getBruteForceDelay(username);
                        if (bruteForceMsg) {
                            res.status(429).json({ error: bruteForceMsg });
                            return;
                        }

                        void this.checkPassword(username, password, result => {
                            if (result) {
                                if (this.bruteForce[username]) {
                                    delete this.bruteForce[username];
                                }
                                const token = this.createSessionToken(username);
                                res.cookie('xterm_session', token, {
                                    httpOnly: true,
                                    secure: this.config.secure,
                                    sameSite: 'lax',
                                    maxAge: 24 * 60 * 60 * 1000,
                                    path: '/',
                                });
                                res.json({ ok: true });
                            } else {
                                this.bruteForce[username] = this.bruteForce[username] || { errors: 0, time: 0 };
                                this.bruteForce[username].time = Date.now();
                                this.bruteForce[username].errors++;
                                res.status(401).json({ error: 'Invalid credentials' });
                            }
                        });
                    });

                    serverObj.app.post('/api/logout', (_req: express.Request, res: express.Response) => {
                        res.clearCookie('xterm_session', { path: '/' });
                        res.json({ ok: true });
                    });

                    // Session check middleware
                    serverObj.app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
                        if (this.verifySessionCookie(req)) {
                            return next();
                        }
                        if (req.path.startsWith('/api/')) {
                            res.status(401).json({ error: 'Not authenticated' });
                            return;
                        }
                        res.redirect('/login');
                    });
                } else if (this.config.auth) {
                    // Basic auth mode
                    serverObj.app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
                        this.auth(req, (result, text) => {
                            if (result) {
                                next();
                            } else if (text) {
                                res.status(429).send(text);
                            } else {
                                res.set('WWW-Authenticate', 'Basic realm="xterm"');
                                res.status(401).send('Unauthorized');
                            }
                        });
                    });
                }

                // Serve static files from public/
                serverObj.app.use(express.static(path.join(__dirname, '..', 'public')));
                // SPA fallback
                serverObj.app.use((_req: express.Request, res: express.Response) => {
                    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
                });

                try {
                    const webserver = new IoBWebServer({
                        app: serverObj.app,
                        adapter: this,
                        secure: settings.secure,
                    });
                    serverObj.server = await webserver.init();
                } catch (err) {
                    this.log.error(`Cannot create webserver: ${err}`);
                    if (this.terminate) {
                        this.terminate(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                    } else {
                        process.exit(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                    }
                    return;
                }

                if (!serverObj.server) {
                    this.log.error('Cannot create webserver');
                    if (this.terminate) {
                        this.terminate(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                    } else {
                        process.exit(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                    }
                    return;
                }

                let serverListening = false;
                serverObj.server.on('error', (e: Error) => {
                    if (e.toString().includes('EACCES') && port <= 1024) {
                        this.log.error(
                            `node.js process has no rights to start server on the port ${port}.\n` +
                                `Do you know that on linux you need special permissions for ports under 1024?\n` +
                                `You can call in shell following scrip to allow it for node.js: "iobroker fix"`,
                        );
                    } else {
                        this.log.error(`Cannot start server on ${settings.bind || '0.0.0.0'}:${port}: ${e}`);
                    }
                    if (!serverListening) {
                        if (this.terminate) {
                            this.terminate(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                        } else {
                            process.exit(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                        }
                    }
                });

                serverObj.server.listen(
                    settings.port,
                    !settings.bind || settings.bind === '0.0.0.0' ? undefined : settings.bind || undefined,
                    () => {
                        serverListening = true;
                        this.log.debug(`XTerm is listening on ${this.config.port || 8099}`);
                    },
                );

                serverObj.server.on('upgrade', (request, socket: Socket & { ___auth?: boolean }, head: Buffer) => {
                    // A socket that fails during the handshake must not crash the adapter
                    socket.on('error', (err: Error) => this.log.debug(`Upgrade socket error: ${err.message}`));

                    if (this.config.auth) {
                        if (this.config.authType === 'digest') {
                            // Digest auth: verify session cookie
                            const authenticated = this.verifySessionCookie(request);
                            socket.___auth = authenticated;
                            if (authenticated) {
                                serverObj.io!.handleUpgrade(request, socket, head, (ws: WebSocket) =>
                                    serverObj.io!.emit('connection', ws, request),
                                );
                            } else {
                                this.log.error('WebSocket: invalid or missing session');
                                socket.destroy();
                            }
                        } else {
                            // Basic auth
                            this.auth(request, result => {
                                socket.___auth = result;
                                if (result) {
                                    serverObj.io!.handleUpgrade(request, socket, head, (ws: WebSocket) =>
                                        serverObj.io!.emit('connection', ws, request),
                                    );
                                } else {
                                    this.log.error('Cannot establish socket connection as no credentials found!');
                                    socket.destroy();
                                }
                            });
                        }
                    } else {
                        serverObj.io!.handleUpgrade(request, socket, head, (ws: WebSocket) =>
                            serverObj.io!.emit('connection', ws, request),
                        );
                    }
                });

                serverObj.io = new WebSocketServer({ noServer: true });
                serverObj.io.on('error', (err: Error) => this.log.error(`WebSocket server error: ${err.message}`));
                serverObj.io.on('connection', (ws: WebSocket) => this.initSocketConnection(ws as XtermWebSocket));
            },
        );

        return serverObj;
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<AdapterOptions>): XtermAdapter => new XtermAdapter(options);
} else {
    (() => new XtermAdapter())();
}
