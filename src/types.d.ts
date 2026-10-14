export interface XtermAdapterConfig {
    bind: string;
    port: number;
    secure: boolean;
    /** Speak HTTP/2 with HTTP/1.1 fallback, only if `secure` (default: true) */
    http2?: boolean;
    auth: boolean;
    authType: 'basic' | 'digest';
    cwd: string;
    shellUser: string;
    /** How long a terminal keeps running after the browser disconnected (in minutes, 0 = terminate immediately) */
    sessionTimeout: number;
    findNextPort?: boolean;
}
