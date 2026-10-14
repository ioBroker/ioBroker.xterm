export interface XtermAdapterConfig {
    bind: string;
    port: number;
    secure: boolean;
    /** Speak HTTP/2 with HTTP/1.1 fallback, only if `secure` (default: true) */
    http2?: boolean;
    auth: boolean;
    authType: 'basic' | 'digest';
    /** Accept the login of an administrator in ioBroker admin instead of the own login (default: true) */
    adminSession?: boolean;
    cwd: string;
    shellUser: string;
    /** How long a terminal keeps running after the browser disconnected (in minutes, 0 = terminate immediately) */
    sessionTimeout: number;
    findNextPort?: boolean;
}
