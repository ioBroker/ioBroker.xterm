import type { ITheme } from '@xterm/xterm';

export type ThemeType = 'dark' | 'light';

export const DARK_THEME: ITheme = {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78',
    selectionForeground: '#ffffff',
    black: '#1e1e1e',
    red: '#f44747',
    green: '#6a9955',
    yellow: '#d7ba7d',
    blue: '#569cd6',
    magenta: '#c586c0',
    cyan: '#4ec9b0',
    white: '#d4d4d4',
    brightBlack: '#808080',
    brightRed: '#f44747',
    brightGreen: '#6a9955',
    brightYellow: '#d7ba7d',
    brightBlue: '#569cd6',
    brightMagenta: '#c586c0',
    brightCyan: '#4ec9b0',
    brightWhite: '#ffffff',
};

export const LIGHT_THEME: ITheme = {
    background: '#ffffff',
    foreground: '#333333',
    cursor: '#333333',
    cursorAccent: '#ffffff',
    selectionBackground: '#add6ff',
    selectionForeground: '#000000',
    black: '#000000',
    red: '#cd3131',
    green: '#008000',
    yellow: '#795e26',
    blue: '#0451a5',
    magenta: '#bc05bc',
    cyan: '#0598bc',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#cd3131',
    brightGreen: '#14ce14',
    brightYellow: '#b5ba00',
    brightBlue: '#0451a5',
    brightMagenta: '#bc05bc',
    brightCyan: '#0598bc',
    brightWhite: '#a5a5a5',
};

export function getTerminalTheme(themeType: ThemeType): ITheme {
    return themeType === 'dark' ? DARK_THEME : LIGHT_THEME;
}

/** Detect a theme type from URL query (?react=dark/light), ioBroker localStorage, or system preference */
export function detectThemeType(themeName?: string): ThemeType {
    if (themeName) {
        return themeName === 'dark' || themeName === 'blue' ? 'dark' : 'light';
    }
    // 1. URL query parameter `?react=dark` or `?react=light` (highest priority)
    try {
        const params = new URLSearchParams(window.location.search);
        const react = params.get('react');
        if (react === 'dark' || react === 'light') {
            return react;
        }
    } catch {
        // ignore
    }

    // 2. ioBroker localStorage convention
    try {
        const themeName = window.localStorage.getItem('App.themeName');
        if (themeName) {
            return themeName === 'dark' || themeName === 'blue' ? 'dark' : 'light';
        }
    } catch {
        // ignore
    }

    // 3. System preference
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
