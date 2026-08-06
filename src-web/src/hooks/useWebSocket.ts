import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage } from '../types';

interface UseWebSocketOptions {
    onMessage: (msg: ServerMessage) => void;
    onConnected?: () => void;
}

export function useWebSocket({ onMessage, onConnected }: UseWebSocketOptions): {
    connected: boolean;
    send: (msg: ClientMessage) => void;
} {
    const [connected, setConnected] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);
    const onMessageRef = useRef(onMessage);
    const onConnectedRef = useRef(onConnected);

    // Always call the latest callbacks, but do not re-create the connection for that
    useEffect(() => {
        onMessageRef.current = onMessage;
        onConnectedRef.current = onConnected;
    });

    const send = useCallback((msg: ClientMessage) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(msg));
        }
    }, []);

    useEffect(() => {
        let connectTimer: ReturnType<typeof setTimeout> | null = null;
        let connectingTimeout: ReturnType<typeof setTimeout> | null = null;
        // Socket that is currently connecting or connected
        let socket: WebSocket | null = null;
        let disposed = false;

        /** Remove all handlers and close the socket, so it cannot trigger a second reconnect */
        function discard(ws: WebSocket): void {
            ws.onopen = null;
            ws.onerror = null;
            ws.onclose = null;
            ws.onmessage = null;
            try {
                ws.close();
            } catch {
                // ignore
            }
            if (socket === ws) {
                socket = null;
            }
            if (wsRef.current === ws) {
                wsRef.current = null;
            }
        }

        function connect(noWait?: boolean): void {
            if (disposed) {
                return;
            }

            connectTimer =
                connectTimer ||
                setTimeout(
                    () => {
                        connectTimer = null;
                        if (disposed) {
                            return;
                        }

                        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                        // `host` already contains the port (if it is not the default one)
                        const ws = new WebSocket(`${protocol}//${window.location.host}`);
                        socket = ws;

                        if (connectingTimeout) {
                            clearTimeout(connectingTimeout);
                        }
                        connectingTimeout = setTimeout(() => {
                            connectingTimeout = null;
                            console.log('Connect timeout');
                            // The socket is still connecting - throw it away before trying again
                            discard(ws);
                            setConnected(false);
                            connect();
                        }, 5000);

                        ws.onopen = () => {
                            if (connectingTimeout) {
                                clearTimeout(connectingTimeout);
                                connectingTimeout = null;
                            }
                            console.log('Connected');
                            wsRef.current = ws;
                            setConnected(true);
                            onConnectedRef.current?.();
                        };

                        ws.onerror = () => {
                            // `onclose` is called afterwards and triggers the reconnect
                            try {
                                ws.close();
                            } catch {
                                // ignore
                            }
                        };

                        ws.onclose = () => {
                            if (connectingTimeout) {
                                clearTimeout(connectingTimeout);
                                connectingTimeout = null;
                            }
                            if (socket === ws) {
                                socket = null;
                            }
                            if (wsRef.current === ws) {
                                wsRef.current = null;
                            }
                            setConnected(false);
                            connect();
                        };

                        ws.onmessage = event => {
                            let msg: ServerMessage;
                            try {
                                msg = JSON.parse(event.data as string) as ServerMessage;
                            } catch {
                                console.error('Cannot parse message from server');
                                return;
                            }
                            onMessageRef.current(msg);
                        };
                    },
                    noWait ? 0 : 5000,
                );
        }

        connect(true);

        return () => {
            disposed = true;
            if (connectTimer) {
                clearTimeout(connectTimer);
            }
            if (connectingTimeout) {
                clearTimeout(connectingTimeout);
            }
            if (socket) {
                discard(socket);
            }
            wsRef.current = null;
        };
    }, []);

    return { connected, send };
}
