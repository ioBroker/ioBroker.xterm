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
    | { method: 'data'; tabId: string; data: string }
    | { method: 'created'; tabId: string }
    | { method: 'closed'; tabId: string };
