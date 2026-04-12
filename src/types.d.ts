export interface XtermAdapterConfig {
    bind: string;
    port: number;
    secure: boolean;
    auth: boolean;
    cwd: string;
    findNextPort?: boolean;
}
