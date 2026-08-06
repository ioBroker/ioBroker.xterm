/*
 * Integration tests for the server side terminal sessions.
 *
 * These tests run the compiled adapter (build/main.js) in-process with a stubbed
 * `@iobroker/adapter-core` and `@iobroker/webserver`, so no js-controller is needed.
 * A real web socket client talks to the adapter and a real shell is started via node-pty.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..', '..');
const MAIN_FILE = path.join(ROOT_DIR, 'build', 'main.js');

const { WebSocket } = require('ws');

/** Configuration of the adapter under test. It is modified by single tests */
const config = {
    bind: '127.0.0.1',
    port: 0,
    secure: false,
    auth: false,
    authType: 'basic',
    cwd: ROOT_DIR,
    shellUser: '',
    sessionTimeout: 5,
};

/** Minimal replacement for the ioBroker adapter class */
class FakeAdapter {
    constructor(options) {
        this.name = options.name;
        this.config = config;
        this.states = {};
        this.log = {
            error: msg => console.error(`        adapter error: ${msg}`),
            warn: () => {},
            info: () => {},
            debug: () => {},
        };
        this.readyCb = options.ready;
        this.unloadCb = options.unload;
    }

    getObjectAsync() {
        return Promise.resolve(null);
    }

    setObjectAsync() {
        return Promise.resolve();
    }

    setStateAsync(id, value) {
        this.states[id] = value;
        return Promise.resolve();
    }

    setStateChangedAsync(id, value) {
        this.states[id] = value;
        return Promise.resolve();
    }

    getPort(port, _bind, callback) {
        callback(port);
    }

    checkPassword(_username, _password, callback) {
        callback(true);
    }

    terminate(code) {
        throw new Error(`Adapter requested termination with code ${code}`);
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/**
 * The shell echoes the typed command, so a marker appears twice as soon as the command was executed:
 * once as the echo of the input and once as the output of `echo`.
 */
function countOccurrences(text, marker) {
    return text.split(marker).length - 1;
}

/** Wait until `check` returns true */
async function waitFor(check, what, timeoutMs = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (check()) {
            return;
        }
        await sleep(50);
    }
    throw new Error(`Timeout while waiting for ${what}`);
}

describe('Terminal sessions', function () {
    this.timeout(90000);

    /** Modules that were replaced by a stub and must be restored afterwards */
    const replacedModules = new Map();
    /** All web sockets that were opened by the tests */
    const openSockets = [];

    let adapter;
    let port;
    let unloaded = false;

    function stubModule(request, exports) {
        const resolved = require.resolve(request, { paths: [ROOT_DIR] });
        replacedModules.set(resolved, require.cache[resolved]);
        require.cache[resolved] = {
            id: resolved,
            filename: resolved,
            loaded: true,
            exports,
            children: [],
            paths: [],
        };
    }

    function restoreModules() {
        for (const [resolved, original] of replacedModules) {
            if (original) {
                require.cache[resolved] = original;
            } else {
                delete require.cache[resolved];
            }
        }
        replacedModules.clear();
        delete require.cache[require.resolve(MAIN_FILE)];
    }

    /** Open a web socket that collects all messages and the terminal output */
    function connect() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`);
            ws.messages = [];
            ws.output = '';
            ws.on('message', raw => {
                const message = JSON.parse(raw.toString());
                ws.messages.push(message);
                if (message.method === 'data' || message.method === 'restore') {
                    ws.output += message.data;
                }
            });
            ws.on('error', reject);
            ws.on('open', () => {
                openSockets.push(ws);
                resolve(ws);
            });
        });
    }

    const send = (ws, message) => ws.send(JSON.stringify(message));

    /** Open a terminal and wait until the server confirms it */
    async function createTerminal(ws, tabId) {
        send(ws, { method: 'create', tabId });
        await waitFor(() => ws.messages.some(m => m.method === 'created' && m.tabId === tabId), '"created"');
        return ws.messages.find(m => m.method === 'created' && m.tabId === tabId);
    }

    function unload() {
        if (unloaded) {
            return Promise.resolve();
        }
        unloaded = true;
        return new Promise(resolve => adapter.unloadCb(resolve));
    }

    before(async function () {
        if (!fs.existsSync(MAIN_FILE)) {
            console.log('        build/main.js is missing - run "npm run build:tsc" first');
            this.skip();
        }

        port = await getFreePort();
        config.port = port;

        stubModule('@iobroker/adapter-core', {
            Adapter: FakeAdapter,
            EXIT_CODES: { ADAPTER_REQUESTED_TERMINATION: 11 },
            getAbsoluteDefaultDataDir: () => path.join(ROOT_DIR, 'iobroker-data', path.sep),
        });
        stubModule('@iobroker/webserver', {
            WebServer: class {
                constructor(options) {
                    this.app = options.app;
                }

                init() {
                    return Promise.resolve(http.createServer(this.app));
                }
            },
        });

        adapter = require(MAIN_FILE)({});
        await adapter.readyCb();
        await waitFor(() => adapter.server?.io, 'the web server to start');
    });

    after(async () => {
        for (const ws of openSockets) {
            try {
                ws.terminate();
            } catch {
                // ignore
            }
        }
        if (adapter) {
            await unload();
        }
        restoreModules();
    });

    it('starts a shell and executes a command', async () => {
        const ws = await connect();
        const created = await createTerminal(ws, 'tab-1');

        assert.equal(created.restored, false, 'a new terminal must not be reported as restored');
        assert.equal(adapter.sessions.size, 1, 'the adapter must hold one session');

        await sleep(1000); // let the shell settle
        send(ws, { method: 'key', tabId: 'tab-1', key: 'echo MARKER_ALPHA\r' });

        await waitFor(() => countOccurrences(ws.output, 'MARKER_ALPHA') >= 2, 'command output');
    });

    it('keeps the shell running if the connection is lost', async () => {
        const session = adapter.sessions.get('tab-1');
        const shellBefore = session.pty;

        openSockets[0].terminate();
        await waitFor(() => adapter.sessions.get('tab-1')?.ws === null, 'the session to be detached');

        assert.equal(adapter.sessions.size, 1, 'the session must survive the disconnection');
        assert.equal(adapter.sessions.get('tab-1').pty, shellBefore, 'the very same shell must still run');
        assert.notEqual(adapter.sessions.get('tab-1').killTimer, null, 'the kill timer must be armed');
    });

    it('restores the terminal content after a reconnection', async () => {
        const shellBefore = adapter.sessions.get('tab-1').pty;

        const ws = await connect();
        const created = await createTerminal(ws, 'tab-1');
        await waitFor(() => ws.messages.some(m => m.method === 'restore'), '"restore"');

        assert.equal(created.restored, true, 'the reconnection must be reported as restored');
        assert.ok(/MARKER_ALPHA/.test(ws.output), 'the replayed content must contain the earlier output');
        assert.equal(adapter.sessions.get('tab-1').killTimer, null, 'the kill timer must be disarmed');
        assert.equal(adapter.sessions.get('tab-1').pty, shellBefore, 'the shell must not have been restarted');
    });

    it('the restored shell still accepts commands', async () => {
        const ws = openSockets[openSockets.length - 1];
        send(ws, { method: 'key', tabId: 'tab-1', key: 'echo MARKER_BETA\r' });

        await waitFor(() => countOccurrences(ws.output, 'MARKER_BETA') >= 2, 'output of the second command');
    });

    it('ignores commands of a connection that does not own the session', async () => {
        const owner = openSockets[openSockets.length - 1];
        const foreign = await connect();

        send(foreign, { method: 'key', tabId: 'tab-1', key: 'echo INTRUDER\r' });
        await sleep(1500);

        assert.ok(!/INTRUDER/.test(owner.output), 'the foreign connection must not write into the session');
        foreign.close();
    });

    it('terminates the session if the terminal is closed explicitly', async () => {
        const ws = openSockets[openSockets.length - 2];

        send(ws, { method: 'close', tabId: 'tab-1' });
        await waitFor(() => ws.messages.some(m => m.method === 'closed'), '"closed"');

        assert.equal(adapter.sessions.size, 0, 'the session must be gone');
    });

    it('terminates the shell immediately if the session timeout is 0', async () => {
        config.sessionTimeout = 0;
        try {
            const ws = await connect();
            await createTerminal(ws, 'tab-2');
            assert.equal(adapter.sessions.size, 1, 'the session must exist');

            ws.terminate();
            await waitFor(() => adapter.sessions.size === 0, 'the session to be terminated');
        } finally {
            config.sessionTimeout = 5;
        }
    });

    it('survives invalid messages', async () => {
        const ws = await connect();

        ws.send('this is not json');
        ws.send(JSON.stringify({ method: 'resize', tabId: 'tab-3', cols: -5, rows: NaN }));
        ws.send(JSON.stringify({ method: 'key' }));
        ws.send(JSON.stringify({ method: 'create' }));
        await sleep(500);

        assert.equal(ws.readyState, WebSocket.OPEN, 'the adapter must still be alive');
        assert.equal(adapter.sessions.size, 0, 'no session must have been created');
    });

    it('terminates all shells when the adapter stops', async () => {
        const ws = await connect();
        await createTerminal(ws, 'tab-4');

        const shell = adapter.sessions.get('tab-4').pty;
        let exited = false;
        shell.onExit(() => (exited = true));

        await unload();

        assert.equal(adapter.sessions.size, 0, 'all sessions must be removed');
        await waitFor(() => exited, 'the shell process to exit', 10000);
    });
});
