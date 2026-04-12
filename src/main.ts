import { Adapter, type AdapterOptions, EXIT_CODES, getAbsoluteDefaultDataDir } from '@iobroker/adapter-core';
import { WebServer as IoBWebServer } from '@iobroker/webserver';
import fs from 'node:fs';
import os from 'node:os';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import * as pty from 'node-pty';
import type { Socket, AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';

import type { XtermAdapterConfig } from './types';

interface FileEntry {
    path: string;
    contentType: string;
    data?: string | Buffer;
}

interface IobrokerMeta {
    cwd: string;
    address: string;
    ptyProcess?: pty.IPty;
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
    return parts.join('/');
}

class XtermAdapter extends Adapter {
    declare config: XtermAdapterConfig;

    private server: WebServerInstance | null = null;
    private connectedIPs: string[] = [];
    private bruteForce: Record<string, BruteForceEntry> = {};
    private IOB_DIR: string = findIoBrokerDirectory();
    private files: Record<string, FileEntry> = {};
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

        this.initFileMap();
    }

    private initFileMap(): void {
        const locationXterm = require.resolve('@xterm/xterm').replace(/\\/g, '/');
        const locationXtermFit = require.resolve('@xterm/addon-fit').replace(/\\/g, '/');
        const locationXtermWebgl = require.resolve('@xterm/addon-webgl').replace(/\\/g, '/');
        const locationXtermWebLinks = require.resolve('@xterm/addon-web-links').replace(/\\/g, '/');
        const locationXtermSearch = require.resolve('@xterm/addon-search').replace(/\\/g, '/');

        this.files = {
            'xterm.js': { path: locationXterm, contentType: 'text/javascript' },
            'xterm.js.map': { path: `${locationXterm}.map`, contentType: 'text/javascript' },
            'xterm.css': {
                path: locationXterm.replace('/lib/xterm.js', '/css/xterm.css'),
                contentType: 'text/css',
            },
            'xterm-addon-fit.js': { path: locationXtermFit, contentType: 'text/javascript' },
            'xterm-addon-fit.js.map': { path: `${locationXtermFit}.map`, contentType: 'text/javascript' },
            'xterm-addon-webgl.js': { path: locationXtermWebgl, contentType: 'text/javascript' },
            'xterm-addon-webgl.js.map': { path: `${locationXtermWebgl}.map`, contentType: 'text/javascript' },
            'xterm-addon-web-links.js': { path: locationXtermWebLinks, contentType: 'text/javascript' },
            'xterm-addon-web-links.js.map': { path: `${locationXtermWebLinks}.map`, contentType: 'text/javascript' },
            'xterm-addon-search.js': { path: locationXtermSearch, contentType: 'text/javascript' },
            'xterm-addon-search.js.map': { path: `${locationXtermSearch}.map`, contentType: 'text/javascript' },
            'index.html': { path: `${__dirname}/../public/index.html`, contentType: 'text/html' },
            'favicon.ico': { path: `${__dirname}/../public/favicon.ico`, contentType: 'image/x-icon' },
        };
    }

    private onUnload(callback: () => void): void {
        try {
            // First sweep, soft close
            if (this.server?.io) {
                this.server.io.clients.forEach(socket => socket.close());
            }

            setTimeout(() => {
                // Second sweep, hard close for everyone who's left
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

    private startShell(ws: XtermWebSocket): void {
        const shell = os.platform() === 'win32' ? 'cmd.exe' : 'bash';

        if (!ws?.__iobroker) {
            return;
        }

        ws.__iobroker.ptyProcess = pty.spawn(shell, [], {
            name: 'xterm-256color',
            cols: 80,
            rows: 30,
            cwd: this.IOB_DIR,
            env: process.env as Record<string, string>,
        });

        ws.__iobroker.ptyProcess.onData((data: string) => ws.send(JSON.stringify({ data })));

        ws.__iobroker.ptyProcess.onExit(() => {
            if (ws.__iobroker) {
                this.startShell(ws);
            }
        });
    }

    private initSocketConnection(ws: XtermWebSocket): void {
        ws.__iobroker = {
            cwd: this.IOB_DIR,
            address: (ws._socket.address() as AddressInfo).address,
        };

        if (this.config.auth && !ws._socket.___auth) {
            ws.close();
            this.log.error('Cannot establish socket connection as no credentials found!');
            return;
        }

        this.startShell(ws);

        if (!this.connectedIPs.includes(ws.__iobroker.address)) {
            this.connectedIPs.push(ws.__iobroker.address);
        }
        void this.setStateAsync('info.connection', this.connectedIPs.join(', ') || 'none', true);

        ws.on('message', (rawMessage: Buffer | string) => {
            if (!ws.__iobroker) {
                return;
            }
            const message = JSON.parse(rawMessage.toString());
            if (message.method === 'resize') {
                ws.__iobroker.ptyProcess?.resize(message.cols, message.rows);
            } else if (message.method === 'key') {
                ws.__iobroker.ptyProcess?.write(message.key);
            }
        });

        ws.on('close', () => {
            if (ws.__iobroker?.ptyProcess) {
                try {
                    ws.__iobroker.ptyProcess.kill();
                } catch {
                    // ignore
                }
            }
            if (ws.__iobroker) {
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

                serverObj.app.use((req: express.Request, res: express.Response) => {
                    let file = req.url.split('?')[0];
                    file = file.split('/').pop()!;

                    if (this.files[file]) {
                        res.setHeader('Content-Type', this.files[file].contentType);
                        if (this.files[file].data) {
                            res.send(this.files[file].data);
                        } else {
                            res.send(fs.readFileSync(this.files[file].path));
                        }
                    } else if (!file || file === '/') {
                        res.setHeader('Content-Type', this.files['index.html'].contentType);
                        if (this.files['index.html'].data) {
                            res.send(this.files['index.html'].data);
                        } else {
                            res.send(fs.readFileSync(this.files['index.html'].path));
                        }
                    } else {
                        res.status(404).json({ error: 'not found' });
                    }
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

                // Start the web server
                serverObj.server.listen(
                    settings.port,
                    !settings.bind || settings.bind === '0.0.0.0' ? undefined : settings.bind || undefined,
                    () => {
                        serverListening = true;
                        this.log.debug(`XTerm is listening on ${this.config.port || 8099}`);
                    },
                );

                // upgrade socket
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
