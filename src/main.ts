import { Adapter, type AdapterOptions, EXIT_CODES, getAbsoluteDefaultDataDir } from '@iobroker/adapter-core';
import { WebServer as IoBWebServer } from '@iobroker/webserver';
import { exec, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import * as iconv from 'iconv-lite';
import { WebSocketServer, type WebSocket } from 'ws';
import type * as PTy from 'node-pty';
import type { Socket, AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';

import type { XtermAdapterConfig } from './types';

let pty: typeof PTy | undefined;

interface FileEntry {
    path: string;
    contentType: string;
    data?: string | Buffer;
}

interface IobrokerMeta {
    cwd: string;
    env: Record<string, string | undefined>;
    encoding: string;
    address: string;
    ptyProcess?: PTy.IPty;
}

interface XtermWebSocket extends WebSocket {
    __iobroker?: IobrokerMeta;
    _stdin: NodeJS.WritableStream | null;
    _process: ChildProcess | null;
    _isExecuting: boolean;
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
        const locationXterm = require.resolve('xterm').replace(/\\/g, '/');
        const locationXtermFit = require.resolve('xterm-addon-fit').replace(/\\/g, '/');
        const locationXtermCanvas = require.resolve('xterm-addon-canvas').replace(/\\/g, '/');

        this.files = {
            'xterm.js': { path: locationXterm, contentType: 'text/javascript' },
            'xterm.js.map': { path: `${locationXterm}.map`, contentType: 'text/javascript' },
            'xterm.css': {
                path: locationXterm.replace('/lib/xterm.js', '/css/xterm.css'),
                contentType: 'text/css',
            },
            'xterm-addon-fit.js': { path: locationXtermFit, contentType: 'text/javascript' },
            'xterm-addon-fit.js.map': { path: `${locationXtermFit}.map`, contentType: 'text/javascript' },
            'xterm-addon-canvas.js': { path: locationXtermCanvas, contentType: 'text/javascript' },
            'xterm-addon-canvas.js.map': { path: `${locationXtermCanvas}.map`, contentType: 'text/javascript' },
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

        if (this.config.doNotUseCanvas) {
            let index = fs.readFileSync(`${__dirname}/../public/index.html`).toString();
            index = index.replace('<script src="./xterm-addon-canvas.js"></script>', '');
            this.files['index.html'].data = index;
        }

        await this.setStateChangedAsync('info.connection', '', true);
        this.config.encoding = this.config.encoding || 'utf-8';
        this.server = this.initWebServer(this.config);
        await this.setStateChangedAsync('info.connection', 'none', true);
    }

    private executeCommand(command: string, ws: XtermWebSocket, cb?: (code: number | null) => void): void {
        if (!ws.__iobroker) {
            throw new Error('Invalid socket');
        }
        ws.__iobroker.encoding = '';
        const ls = exec(command, { cwd: ws.__iobroker.cwd, env: ws.__iobroker.env, encoding: 'buffer' });

        ls.stdout?.on('data', (data: Buffer) => {
            const decoded = iconv.decode(data, this.config.encoding);
            ws.send(JSON.stringify({ data: decoded }));
        });

        ls.stderr?.on('data', (data: Buffer) => {
            const decoded = iconv.decode(data, this.config.encoding);
            this.log.error(`stderr: ${decoded}`);
            ws.send(JSON.stringify({ data: decoded, error: true }));
        });

        ls.on('exit', (code: number | null) => {
            ws._stdin = null;
            ws._process = null;
            this.log.debug(`child process exited with code ${code === null ? 'null' : code.toString()}`);
            // wait for the outputs
            if (cb) {
                setTimeout(() => cb(code), 100);
            }
        });

        ws._stdin = ls.stdin;
        ws._process = ls;
    }

    private static isDirectory(thePath: string): boolean {
        return fs.existsSync(thePath) && fs.statSync(thePath).isDirectory();
    }

    private cd(thePath: string, ws: XtermWebSocket): string | { data: string; prompt?: string } {
        thePath = thePath.trim().replace(/\\/g, '/');
        if (!ws.__iobroker) {
            throw new Error('Invalid socket');
        }
        if (!thePath) {
            thePath = ws.__iobroker.cwd;
        }

        if (thePath) {
            if (thePath === '.') {
                // do not change anything
            } else if (thePath === '..') {
                const parts = ws.__iobroker.cwd.split('/');
                if (parts.length > 1) {
                    parts.pop();
                }
                ws.__iobroker.cwd = parts.join('/');
            } else if (/^\w:/.test(thePath) || thePath.startsWith('/')) {
                // full path
                if (XtermAdapter.isDirectory(thePath)) {
                    ws.__iobroker.cwd = thePath;
                } else {
                    return { data: `cd ${thePath}: No such directory` };
                }
            } else {
                // add to current
                thePath = path.join(ws.__iobroker.cwd, thePath).replace(/\\/g, '/');
                if (XtermAdapter.isDirectory(thePath)) {
                    ws.__iobroker.cwd = thePath;
                } else {
                    return { data: `cd ${thePath}: No such directory` };
                }
            }
        }

        return ws.__iobroker.cwd.includes('/') ? ws.__iobroker.cwd : `${ws.__iobroker.cwd}/`;
    }

    private completion(pattern: string, ws: XtermWebSocket): string[] {
        let scanPath = '';
        let completionPrefix = '';
        let data: string[] = [];
        if (!ws.__iobroker) {
            throw new Error('Invalid socket');
        }
        if (pattern) {
            if (!XtermAdapter.isDirectory(pattern)) {
                pattern = path.dirname(pattern);
                pattern = pattern === '.' ? '' : pattern;
            }
            if (pattern) {
                if (XtermAdapter.isDirectory(pattern)) {
                    scanPath = pattern;
                    completionPrefix = pattern;
                    if (completionPrefix.endsWith('/')) {
                        completionPrefix += '/';
                    }
                }
            } else {
                scanPath = ws.__iobroker.cwd;
            }
        } else {
            scanPath = ws.__iobroker.cwd;
        }

        if (scanPath) {
            data = fs.readdirSync(scanPath);
            data.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

            if (completionPrefix && data.length > 0) {
                data = data.map(c => completionPrefix + c);
            }
            if (pattern && data.length > 0) {
                data = data.filter(c => c.substring(0, pattern.length) === pattern);
            }
        }

        return data;
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

        this.checkPassword(username, password, result => {
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

        if (!ws) {
            return;
        }
        if (!ws.__iobroker) {
            throw new Error('Invalid socket');
        }
        ws.__iobroker.ptyProcess = pty!.spawn(shell, [], {
            name: `xterm-color-${Date.now()}`,
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

    private async initSocketConnection(ws: XtermWebSocket): Promise<void> {
        ws.__iobroker = {
            cwd: this.IOB_DIR,
            env: JSON.parse(JSON.stringify(process.env)),
            encoding: 'buffer',
            address: (ws._socket.address() as AddressInfo).address,
        };

        if (this.config.auth && !ws._socket.___auth) {
            ws.close();
            this.log.error('Cannot establish socket connection as no credentials found!');
            return;
        }

        if (this.config.pty) {
            try {
                pty = pty || (await import('node-pty'));
            } catch {
                this.log.error('node-pty was not installed, can not use bash/cmd.exe - fallback to simulated shell!');
                this.config.pty = false;
            }
        }

        if (this.config.pty) {
            this.startShell(ws);
        }

        if (!this.connectedIPs.includes(ws.__iobroker.address)) {
            this.connectedIPs.push(ws.__iobroker.address);
        }
        this.setState('info.connection', this.connectedIPs.join(', ') || 'none', true);

        ws.on('message', (rawMessage: Buffer | string) => {
            if (!ws.__iobroker) {
                return;
            }
            const message = JSON.parse(rawMessage.toString());
            if (message.method === 'resize') {
                ws.__iobroker.ptyProcess?.resize(message.cols, message.rows);
            } else if (message.method === 'prompt') {
                ws.send(
                    JSON.stringify({
                        data: '',
                        prompt: `${ws.__iobroker.cwd}>`,
                    }),
                );
            } else if (message.method === 'key') {
                if (ws.__iobroker.ptyProcess) {
                    ws.__iobroker.ptyProcess.write(message.key);
                } else if (message.key === '\u0003' && ws._process?.kill) {
                    ws._process.kill();
                } else if (ws._stdin) {
                    ws._stdin.write(message.key);
                }
            } else if (message.method === 'tab') {
                const str = this.completion(message.start, ws);
                ws.send(JSON.stringify({ completion: str }));
            } else if (message.method === 'command') {
                this.handleCommand(message, ws);
            }
        });

        ws.on('close', () => {
            if (ws._process) {
                try {
                    ws._process.kill();
                } catch {
                    // ignore
                }
                ws._process = null;
                ws._stdin = null;
            }
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
            this.setState('info.connection', this.connectedIPs.join(', ') || 'none', true);
        });

        ws.send(JSON.stringify({ mode: this.config.pty ? 'pty' : 'simulate' }));
        if (!this.config.pty && ws.__iobroker) {
            ws.send(JSON.stringify({ prompt: `${ws.__iobroker.cwd}>` }));
        }

        this.log.debug('WebSocket connection established');
    }

    private handleCommand(message: { command: string }, ws: XtermWebSocket): void {
        if (ws._isExecuting) {
            return;
        }
        if (!ws.__iobroker) {
            throw new Error('Invalid socket');
        }
        if (!message.command) {
            ws.send(JSON.stringify({ prompt: `${ws.__iobroker.cwd}>` }));
            return;
        }

        // fix user typo
        if (message.command === 'cd..') {
            message.command = 'cd ..';
        } else if (message.command === 'cd') {
            message.command = 'cd .';
        }

        if (message.command.startsWith('cd ')) {
            const result = this.cd(message.command.substring(3), ws);
            if (typeof result === 'string') {
                ws.send(
                    JSON.stringify({
                        data: '',
                        prompt: `${result}>`,
                    }),
                );
            } else {
                result.prompt = `${ws.__iobroker.cwd}>`;
                ws.send(JSON.stringify(result));
            }
        } else if (message.command === 'pwd') {
            ws.send(
                JSON.stringify({
                    prompt: `${ws.__iobroker.cwd}>`,
                    data: ws.__iobroker.cwd,
                }),
            );
        } else if (message.command === 'set' || message.command === 'env') {
            ws.send(
                JSON.stringify({
                    prompt: `${ws.__iobroker.cwd}>`,
                    data: Object.keys(ws.__iobroker.env)
                        .map(v => `${v}=${ws.__iobroker!.env[v]}`)
                        .sort()
                        .join('\r\n'),
                }),
            );
        } else if (message.command === 'export') {
            ws.send(
                JSON.stringify({
                    prompt: `${ws.__iobroker.cwd}>`,
                    data: Object.keys(ws.__iobroker.env)
                        .map(v => `declare -x ${v}="${ws.__iobroker!.env[v]}"`)
                        .sort()
                        .join('\r\n'),
                }),
            );
        } else if (message.command.startsWith('set ') || message.command.startsWith('export ')) {
            let [name, val] = message.command.split('=', 2);

            if (name !== undefined) {
                name = name.trim();
                name = name.split(' ').pop()!;
            }
            if (val !== undefined) {
                val = val.trim().replace(/^"/, '').replace(/"$/, '');
                ws.__iobroker.env[name] = val;
            }

            ws.send(JSON.stringify({ prompt: `${ws.__iobroker.cwd}>` }));
        } else {
            ws._isExecuting = true;
            ws.send(JSON.stringify({ isExecuting: true }));

            let command = message.command;
            if (command === 'node') {
                command += ' -i';
            }

            this.executeCommand(command, ws, code => {
                ws._isExecuting = false;
                if (ws.__iobroker) {
                    ws.send(
                        JSON.stringify({
                            prompt: `${ws.__iobroker.cwd}>`,
                            isExecuting: false,
                            exitCode: code,
                        }),
                    );
                }
            });
        }
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
