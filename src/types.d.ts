export interface XtermAdapterConfig {
    bind: string;
    port: number;
    secure: boolean;
    auth: boolean;
    authType: 'basic' | 'digest';
    cwd: string;
    shellUser: string;
    findNextPort?: boolean;
}
