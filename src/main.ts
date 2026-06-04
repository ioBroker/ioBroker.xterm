import { Adapter, type AdapterOptions, EXIT_CODES, getAbsoluteDefaultDataDir } from '@iobroker/adapter-core';
import { WebServer as IoBWebServer } from '@iobroker/webserver';
import path from 'node:path';
import os from 'node:os';
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
    tabs: Map<string, pty.IPty>;
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

    private startShellForTab(ws: XtermWebSocket, tabId: string): void {
        if (!ws?.__iobroker) {
            return;
        }

        // Kill existing PTY for this tab (e.g. on reconnection or duplicate create)
        const existing = ws.__iobroker.tabs.get(tabId);
        if (existing) {
            ws.__iobroker.tabs.delete(tabId);
            try {
                existing.kill();
            } catch {
                // ignore
            }
        }

        let shell: string;
        let args: string[];
        if (os.platform() === 'win32') {
            shell = 'cmd.exe';
            args = [];
        } else if (this.config.shellUser) {
            shell = 'su';
            args = ['-', this.config.shellUser];
        } else {
            shell = 'bash';
            args = [];
        }

        const ptyProcess = pty.spawn(shell, args, {
            name: 'xterm-256color',
            cols: 80,
            rows: 30,
            cwd: this.config.cwd || this.IOB_DIR,
            env: process.env as Record<string, string>,
        });

        ws.__iobroker.tabs.set(tabId, ptyProcess);

        ptyProcess.onData((data: string) => {
            ws.send(JSON.stringify({ method: 'data', tabId, data }));
        });

        ptyProcess.onExit(() => {
            // Only restart if this PTY is still the active one for this tab
            if (ws.__iobroker?.tabs.get(tabId) === ptyProcess) {
                // Shell exited — restart it
                this.startShellForTab(ws, tabId);
            }
        });

        ws.send(JSON.stringify({ method: 'created', tabId }));
    }

    private initSocketConnection(ws: XtermWebSocket): void {
        ws.__iobroker = {
            address: (ws._socket.address() as AddressInfo).address,
            tabs: new Map(),
        };

        if (this.config.auth && !ws._socket.___auth) {
            ws.close();
            this.log.error('Cannot establish socket connection as no credentials found!');
            return;
        }

        if (!this.connectedIPs.includes(ws.__iobroker.address)) {
            this.connectedIPs.push(ws.__iobroker.address);
        }
        void this.setStateAsync('info.connection', this.connectedIPs.join(', ') || 'none', true);

        ws.on('message', (rawMessage: Buffer | string) => {
            if (!ws.__iobroker) {
                return;
            }
            const message = JSON.parse(rawMessage.toString());

            if (message.method === 'create' && message.tabId) {
                this.startShellForTab(ws, message.tabId);
            } else if (message.method === 'key' && message.tabId) {
                ws.__iobroker.tabs.get(message.tabId)?.write(message.key);
            } else if (message.method === 'resize' && message.tabId) {
                ws.__iobroker.tabs.get(message.tabId)?.resize(message.cols, message.rows);
            } else if (message.method === 'close' && message.tabId) {
                const ptyProcess = ws.__iobroker.tabs.get(message.tabId);
                if (ptyProcess) {
                    ws.__iobroker.tabs.delete(message.tabId);
                    try {
                        ptyProcess.kill();
                    } catch {
                        // ignore
                    }
                }
                ws.send(JSON.stringify({ method: 'closed', tabId: message.tabId }));
            }
        });

        ws.on('close', () => {
            if (ws.__iobroker) {
                // Kill all PTY processes for this connection
                for (const [, ptyProcess] of ws.__iobroker.tabs) {
                    try {
                        ptyProcess.kill();
                    } catch {
                        // ignore
                    }
                }
                ws.__iobroker.tabs.clear();

                const pos = this.connectedIPs.indexOf(ws.__iobroker.address);
                if (pos !== -1) {
                    this.connectedIPs.splice(pos, 1);
                }
                delete ws.__iobroker;
            }
            this.log.debug('WebSocket connection disconnected');
            void this.setStateAsync('info.connection', this.connectedIPs.join(', ') || 'none', true);
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

        // @ts-expect-error to solve
        if (settings.secure && !this.config.certificates) {
            return null;
        }

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
                        adapter: this as ioBroker.Adapter,
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
