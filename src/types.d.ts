export interface XtermAdapterConfig {
    bind: string;
    port: number;
    pty: boolean;
    secure: boolean;
    auth: boolean;
    encoding: string;
    doNotUseCanvas: boolean;
    findNextPort?: boolean;
}
