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
    onMessageRef.current = onMessage;
    onConnectedRef.current = onConnected;

    const send = useCallback((msg: ClientMessage) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(msg));
        }
    }, []);

    useEffect(() => {
        let connectTimer: ReturnType<typeof setTimeout> | null = null;
        let connectingTimeout: ReturnType<typeof setTimeout> | null = null;
        let disposed = false;

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

                        if (connectingTimeout) {
                            clearTimeout(connectingTimeout);
                        }
                        connectingTimeout = setTimeout(() => {
                            console.log('Connect timeout');
                            connect();
                        }, 5000);

                        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                        const ws = new WebSocket(`${protocol}//${window.location.hostname}:${window.location.port}`);

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
                            try {
                                ws.close();
                            } catch {
                                // ignore
                            }
                            wsRef.current = null;
                            setConnected(false);
                            connect();
                        };

                        ws.onclose = () => {
                            wsRef.current = null;
                            setConnected(false);
                            if (!disposed) {
                                connect();
                            }
                        };

                        ws.onmessage = event => {
                            const msg = JSON.parse(event.data as string) as ServerMessage;
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
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, []);

    return { connected, send };
}
