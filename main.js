'use strict';

const utils    = require('@iobroker/adapter-core');
const ws       = require('ws');
const { exec } = require('child_process');
const fs       = require('fs');
const path     = require('path');
const express  = require('express');
const LE       = require(utils.controllerDir + '/lib/letsencrypt.js');
const iconv    = require('iconv-lite');

const locationXterm = require.resolve('xterm').replace(/\\/g, '/');
const locationXtermFit = require.resolve('xterm-addon-fit').replace(/\\/g, '/');

const files = {
    'xterm.js': {path: locationXterm, contentType: 'text/javascript'},
    'xterm.js.map': {path: locationXterm + '.map', contentType: 'text/javascript'},
    'xterm.css': {path: locationXterm.replace('/lib/xterm.js', '/css/xterm.css'), contentType: 'text/css'},
    'xterm-addon-fit.js': {path: locationXtermFit, contentType: 'text/javascript'},
    'xterm-addon-fit.js.map': {path: locationXtermFit + '.map', contentType: 'text/javascript'},
    'index.html': {path: __dirname + '/public/index.html', contentType: 'text/html'},
    'favicon.ico': {path: __dirname + '/public/favicon.ico', contentType: 'image/x-icon'},
};

/**
 * The adapter instance
 * @type {ioBroker.Adapter}
 */
let adapter;
let server;
let connectedCounter = 0;
const bruteForce = {};
const IOB_DIR = findIoBrokerDirectory();

function findIoBrokerDirectory() {
    const dir = utils.controllerDir.replace(/\\/g, '/');
    const parts = dir.split('/');
    let pos = parts.indexOf('iobroker');
    if (pos === -1) {
        pos = parts.indexOf('iob');
    }
    if (pos === -1) {
        pos = parts.indexOf('node_modules');
        if (pos === -1) {
            parts.pop();
            return parts.join('/');
        } else {
            parts.splice(pos - 1);
            return parts.join('/');
        }
    } else {
        parts.splice(pos);
        return parts.join('/');
    }
}

/**
 * Starts the adapter instance
 * @param {Partial<utils.AdapterOptions>} [options]
 */
function startAdapter(options) {
    // Create the adapter and define its methods
    return adapter = utils.adapter(Object.assign({}, options, {
        name: 'xterm',

        // The ready callback is called when databases are connected and adapter received configuration.
        // start here!
        ready: () => {
            if (adapter.config.secure) {
                // Load certificates
                adapter.getCertificates((err, certificates, leConfig) => {
                    adapter.config.certificates = certificates;
                    adapter.config.leConfig     = leConfig;
                    main()
                        .then(() => {});
                });
            } else {
                main()
                    .then(() => {});
            }
        }, // Main method defined below for readability

        // is called when adapter shuts down - callback has to be called under any circumstances!
        unload: callback => {
            try {
                // First sweep, soft close
                server.io && server.io.clients.forEach(socket => socket.close());

                setTimeout(() => {
                    // Second sweep, hard close
                    // for everyone who's left
                    server.io && server.io.clients.forEach(socket => {
                        if ([socket.OPEN, socket.CLOSING].includes(socket.readyState)) {
                            socket.terminate();
                        }
                    });

                    try {
                        server.server && server.server.close();
                    } catch (e) {
                        // ignore
                    }

                    callback();
                }, 300);
            } catch (e) {
                callback();
            }
        },
    }));
}

// Command execution
function executeCommand(command, ws, cb) {
    /*try {
        return execSync(`${command} 2>&1`, {encoding: 'utf8'});
    } catch (e) {
        return e;
    }*/
    ws.__iobroker.encoding = '';
    const ls = exec(command, ws.__iobroker);
    ls.stdout.on('data', data => {
        data = iconv.decode(data, adapter.config.encoding);
        ws.send(JSON.stringify({data}));
    });

    ls.stderr.on('data', data => {
        data = iconv.decode(data, adapter.config.encoding);
        adapter.log.error('stderr: ' + data);
        ws.send(JSON.stringify({data, error: true}));
    });

    ls.on('exit', code => {
        ws._stdin = null;
        ws._process = null;
        console.log(`child process exited with code ${code === null ? 'null' : code.toString()}`);
        // wait for the outputs
        cb && setTimeout(() => cb(code), 100);
    });

    //ls.stdin.setEncoding('utf8');

    ws._stdin = ls.stdin;
    ws._process = ls;
}

function isDirectory(thePath) {
    return fs.existsSync(thePath) && fs.statSync(thePath).isDirectory();
}

function cd(thePath, ws) {
    thePath = thePath.trim().replace(/\\/g, '/');

    if (!thePath) {
        thePath = ws.__iobroker.cwd;
    }
    if (thePath) {
        if (thePath === '.') {
            // do not change anything
        } else if (thePath === '..') {
            const parts = ws.__iobroker.cwd.split('/');
            parts.length > 1 && parts.pop();
            ws.__iobroker.cwd = parts.join('/');
        }

        if (thePath.match(/^\W:/) || thePath.startsWith('/')) {
            // full path
            if (isDirectory(thePath)) {
                ws.__iobroker.cwd = thePath;
            } else {
                return {
                    data: `cd ${thePath}: No such directory`
                };
            }
        } else {
            // add to current
            thePath = path.join(ws.__iobroker.cwd, thePath).replace(/\\/g, '/');
            if (isDirectory(thePath)) {
                ws.__iobroker.cwd = thePath;
            } else {
                return {
                    data: `cd ${thePath}: No such directory`
                };
            }
        }
    }

    return ws.__iobroker.cwd.includes('/') ? ws.__iobroker.cwd : ws.__iobroker.cwd + '/';
}

function completion(pattern, ws) {
    let scanPath = '';
    let completionPrefix = '';
    let data = [];

    if (pattern) {
        if (!isDirectory(pattern)) {
            pattern = path.dirname(pattern);
            pattern = pattern === '.' ? '' : pattern;
        }
        if (pattern) {
            if (isDirectory(pattern)) {
                scanPath = completionPrefix = pattern;
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
        // Loading directory listing
        data = fs.readdirSync(scanPath);
        data.sort(String.naturalCompare);

        // Prefix
        if (completionPrefix && data.length > 0) {
            data = data.map(c => completionPrefix + c);
        }
        // Pattern
        if (pattern && data.length > 0) {
            data = data.filter(c => pattern === c.substr(0, pattern.length));
        }
    }

    return data;
}

let cache = null;
function auth(req, callback) {
    const str = req.headers.Authorization || req.headers.authorization;
    if (cache && Date.now() - cache.ts < 10000 && cache.data === str) {
        return callback(true);
    }
    if (!str || !str.startsWith('Basic ')) {
        cache = null;
        return callback(false);
    }
    const data = Buffer.from(str.substring(6), 'base64').toString();
    const [username, password] = data.split(':');

    if (username !== 'admin' || !password) {
        cache = null;
        return callback(false);
    }

    if (bruteForce[username] && bruteForce[username].errors > 4) {
        let minutes = Date.now() - bruteForce[username].time;
        if (bruteForce[username].errors < 7) {
            if (Date.now() - bruteForce[username].time < 60000) {
                minutes = 1;
            } else {
                minutes = 0;
            }
        } else
        if (bruteForce[username].errors < 10) {
            if (Date.now() - bruteForce[username].time < 180000) {
                minutes = Math.ceil((180000 - minutes) / 60000);
            } else {
                minutes = 0;
            }
        } else
        if (bruteForce[username].errors < 15) {
            if (Date.now() - bruteForce[username].time < 600000) {
                minutes = Math.ceil((600000 - minutes) / 60000);
            } else {
                minutes = 0;
            }
        } else
        if (Date.now() - bruteForce[username].time < 3600000) {
            minutes = Math.ceil((3600000 - minutes) / 60000);
        } else {
            minutes = 0;
        }

        if (minutes) {
            return callback(false, `Too many errors. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`);
        }
    }

    adapter.checkPassword(username, password, result => {
        if (result) {
            cache = {data: str, ts: Date.now()};
            if (bruteForce[username]) {
                delete bruteForce[username];
            }
        } else {
            cache = null;
            bruteForce[username] = bruteForce[username] || {errors: 0};
            bruteForce[username].time = Date.now();
            bruteForce[username].errors++;
        }

        callback(result);
    });
}

function initSocketConnection(ws) {
    ws.__iobroker = {
        cwd: IOB_DIR,
        env: JSON.parse(JSON.stringify(process.env)),
        encoding: 'buffer'
    };

    if (adapter.config.auth && !ws._socket.___auth) {
        ws.close();
        adapter.log.error('Cannot establish socket connection as no credentials found!');
        return;
    }
    connectedCounter++;
    adapter.setState('info.connection', true, true);

    ws.on('message', message => {
        // console.log('received: %s', message);
        message = JSON.parse(message);
        if (message.method === 'prompt') {
            ws.send(JSON.stringify({
                data: '',
                prompt: ws.__iobroker.cwd + '>',
            }));
        } else
        if (message.method === 'key') {
            if (message.key === '\u0003' && ws._process && ws._process.kill) {
                ws._process.kill();
            } else if (ws._stdin) {
                ws._stdin.write(message.key, adapter.config.encoding);
            }
        } else
        if (message.method === 'tab') {
            const str = completion(message.start, ws);
            ws.send(JSON.stringify({completion: str}));
        } else
        if (message.method === 'command') {
            if (!ws._isExecuting) {
                if (!message.command) {
                    ws.send(JSON.stringify({
                        prompt: ws.__iobroker.cwd + '>',
                    }));
                    return;
                }
                // fix user typo
                if (message.command === 'cd..') {
                    message.command === 'cd ..';
                } else if (message.command === 'cd') {
                    message.command === 'cd .';
                }

                if (message.command.startsWith('cd ')) {
                    const result = cd(message.command.substring(3), ws);
                    if (typeof result === 'string') {
                        ws.send(JSON.stringify({
                            data: '',
                            prompt: result + '>',
                        }));
                    } else {
                        result.prompt = ws.__iobroker.cwd + '>';
                        ws.send(JSON.stringify(result));
                    }
                } else if (message.command === 'set' || message.command === 'env') {
                    const result = {
                        prompt: ws.__iobroker.cwd + '>',
                        data: Object.keys(ws.__iobroker.env).map(v => `${v}=${ws.__iobroker.env[v]}`).sort().join('\r\n')
                    };
                    ws.send(JSON.stringify(result));
                } else if (message.command === 'set' || message.command === 'export') {
                    const result = {
                        prompt: ws.__iobroker.cwd + '>',
                        data: Object.keys(ws.__iobroker.env).map(v => `declare -x ${v}="${ws.__iobroker.env[v]}"`).sort().join('\r\n')
                    };
                    ws.send(JSON.stringify(result));
                } else
                if (message.command.startsWith('set ') || message.command.startsWith('export ')) {
                    const result = {
                        prompt: ws.__iobroker.cwd + '>',
                    };
                    let [name, val] = message.command.split('=', 2);

                    if (name !== undefined) {
                        name = name.trim();
                        name = name.split(' ').pop();
                    }
                    if (val !== undefined) {
                        val = val.trim().replace(/^"/, '').replace(/"$/, '');
                        ws.__iobroker.env[name] = val;
                    }

                    ws.send(JSON.stringify(result));
                } else {
                    ws._isExecuting = true;
                    ws.send(JSON.stringify({isExecuting: true}));

                    if (message.command === 'node') {
                        message.command += ' -i';
                    }

                    executeCommand(message.command, ws, code => {
                        ws._isExecuting = false;
                        ws.send(JSON.stringify({
                            prompt: ws.__iobroker.cwd + '>',
                            isExecuting: false,
                            exitCode: code
                        }));
                    });
                }
            }
        }
    });

    ws.on('close', function () {
        if (ws && ws._process) {
            try {
                ws._process.kill();
            } catch (e) {
                // ignore
            }
            ws._process = null;
            ws._stdin = null;
        }

        connectedCounter && connectedCounter--;
        console.log('disconnected');
        if (!connectedCounter) {
            adapter.setState('info.connection', false, true);
        }
    });

    ws.send(JSON.stringify({prompt: ws.__iobroker.cwd + '>'}));

    console.log('connected');
}

//settings: {
//    "port":   8080,
//    "auth":   false,
//    "secure": false,
//    "bind":   "0.0.0.0", // "::"
//}
function initWebServer(settings) {
    const server = {
        app:       null,
        server:    null,
        io:        null,
        settings:  settings
    };

    settings.port = parseInt(settings.port, 10) || 8099;

    if (settings.port) {
        if (settings.secure && !settings.certificates) {
            return null;
        }

        adapter.getPort(settings.port, async port => {
            if (parseInt(port, 10) !== settings.port && !adapter.config.findNextPort) {
                adapter.log.error('port ' + settings.port + ' already in use');
                return adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
            }

            settings.port = port;

            server.app = express();

            if (adapter.config.auth) {
                server.app.use((req, res, next) => {
                    auth(req, (result, text) => {
                        if (result) {
                            next();
                        } else {
                            if (text) {
                                res.status(429).send(text);
                            } else {
                                res.set('WWW-Authenticate', 'Basic realm="xterm"');
                                res.status(401).send('Unauthorized');
                            }
                        }
                    });
                });
            }

            server.app.use((req, res) => {
                let file = req.url.split('?')[0];
                file = file.split('/').pop();

                if (files[file]) {
                    res.setHeader('Content-Type', files[file].contentType);
                    res.send(fs.readFileSync(files[file].path));
                } else if (!file || file === '/') {
                    res.setHeader('Content-Type', files['index.html'].contentType);
                    res.send(fs.readFileSync(files['index.html'].path));
                } else {
                    res.status(404).json({error: 'not found'});
                }
            });

            try {
                server.server = await LE.createServerAsync(server.app, settings, adapter.config.certificates, adapter.config.leConfig, adapter.log, adapter);
            } catch (err) {
                adapter.log.error(`Cannot create webserver: ${err}`);
                adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                return;
            }
            if (!server.server) {
                adapter.log.error(`Cannot create webserver`);
                adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                return;
            }

            let serverListening = false;
            server.server.on('error', e => {
                if (e.toString().includes('EACCES') && port <= 1024) {
                    adapter.log.error(`node.js process has no rights to start server on the port ${port}.\n` +
                        `Do you know that on linux you need special permissions for ports under 1024?\n` +
                        `You can call in shell following scrip to allow it for node.js: "iobroker fix"`
                    );
                } else {
                    adapter.log.error(`Cannot start server on ${settings.bind || '0.0.0.0'}:${port}: ${e}`);
                }
                if (!serverListening) {
                    adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                }
            });

            // Start the web server
            server.server.listen(settings.port, (!settings.bind || settings.bind === '0.0.0.0') ? undefined : settings.bind || undefined, () => {
                serverListening = true;
                adapter.log.debug('XTerm is listening on '  + (adapter.config.port || 8099));
            });

            // upgrade socket
            server.server.on('upgrade', (request, socket, head) => {
                if (adapter.config.auth) {
                    auth(request, result => {
                        socket.___auth = result;
                        if (result) {
                            server.io.handleUpgrade(request, socket, head, socket =>
                                server.io.emit('connection', socket, request));
                        } else {
                            adapter.log.error('Cannot establish socket connection as no credentials found!');
                            socket.destroy();
                        }
                    });
                } else {
                    server.io.handleUpgrade(request, socket, head, socket =>
                        server.io.emit('connection', socket, request));
                }
            });

            settings.crossDomain     = true;
            settings.ttl             = settings.ttl || 3600;
            settings.forceWebSockets = settings.forceWebSockets || false;

            server.io = new ws.Server ({ noServer: true });

            server.io.on('connection', initSocketConnection);
        });
    } else {
        adapter.log.error('port missing');
        adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
    }

    return server;
}

async function main() {
    adapter.config.encoding = adapter.config.encoding || 'utf-8';
    server = initWebServer(adapter.config);
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export startAdapter in compact mode
    module.exports = startAdapter;
} else {
    // otherwise start the instance directly
    startAdapter();
}