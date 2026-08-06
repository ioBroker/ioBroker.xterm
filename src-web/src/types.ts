export interface Tab {
    id: string;
    title: string;
    ready: boolean;
}

// Client -> Server
export type ClientMessage =
    | { method: 'create'; tabId: string }
    | { method: 'key'; tabId: string; key: string }
    | { method: 'resize'; tabId: string; cols: number; rows: number }
    | { method: 'close'; tabId: string };

// Server -> Client
export type ServerMessage =
    // `restored` is true if the terminal was still running on the server
    | { method: 'created'; tabId: string; restored?: boolean }
    // Content of the terminal before the connection was lost
    | { method: 'restore'; tabId: string; data: string }
    | { method: 'data'; tabId: string; data: string }
    | { method: 'closed'; tabId: string };
