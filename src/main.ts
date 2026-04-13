import { Adapter, type AdapterOptions, EXIT_CODES, getAbsoluteDefaultDataDir } from '@iobroker/adapter-core';
import { WebServer as IoBWebServer } from '@iobroker/webserver';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import * as pty from 'node-pty';
import type { Socket, AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
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

    private auth(req: express.Request, callback: (result: boolean, text?: string) => void): void {
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

        if (this.bruteForce[username] && this.bruteForce[username].errors > 4) {
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
                return callback(
                    false,
                    `Too many errors. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
                );
            }
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

    private startShellForTab(ws: XtermWebSocket, tabId: string): void {
        if (!ws?.__iobroker) {
            return;
        }

        // Kill existing PTY for this tab (e.g. on reconnect or duplicate create)
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

                if (this.config.auth) {
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
