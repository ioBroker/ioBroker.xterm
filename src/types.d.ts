export interface XtermAdapterConfig {
    bind: string;
    port: number;
    secure: boolean;
    auth: boolean;
    authType: 'basic' | 'digest';
    cwd: string;
    shellUser: string;
    /** How long a terminal keeps running after the browser disconnected (in minutes, 0 = terminate immediately) */
    sessionTimeout: number;
    findNextPort?: boolean;
}
