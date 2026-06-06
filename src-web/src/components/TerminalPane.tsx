import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { getTerminalTheme, type ThemeType } from '../theme';
import type { ClientMessage } from '../types';
import { SearchBar } from './SearchBar';
import { PasteDialog } from './PasteDialog';
import './TerminalPane.css';

export interface TerminalPaneHandle {
    write: (data: string) => void;
    fit: () => void;
}

interface TerminalPaneProps {
    tabId: string;
    visible: boolean;
    themeType: ThemeType;
    send: (msg: ClientMessage) => void;
}

let internalClipboard = '';

function copyToClipboard(text: string): void {
    internalClipboard = text;
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text: string): void {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
}

async function getTextFromClipboard(): Promise<string> {
    if (navigator.clipboard?.readText) {
        return navigator.clipboard.readText();
    }
    const textArea = document.createElement('textarea');
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.width = '2em';
    textArea.style.height = '2em';
    textArea.style.padding = '0';
    textArea.style.border = 'none';
    textArea.style.outline = 'none';
    textArea.style.boxShadow = 'none';
    textArea.style.background = 'transparent';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    document.execCommand('paste');
    const value = textArea.value || internalClipboard;
    document.body.removeChild(textArea);
    return value;
}

export const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(
    ({ tabId, visible, themeType, send }, ref) => {
        const containerRef = useRef<HTMLDivElement>(null);
        const termRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        const searchAddonRef = useRef<SearchAddon | null>(null);
        const [searchVisible, setSearchVisible] = useState(false);
        const [pasteVisible, setPasteVisible] = useState(false);

        useImperativeHandle(ref, () => ({
            write: (data: string) => {
                termRef.current?.write(data);
            },
            fit: () => {
                if (fitAddonRef.current && containerRef.current?.offsetParent !== null) {
                    fitAddonRef.current.fit();
                }
            },
        }));

        // Initialize terminal
        useEffect(() => {
            if (!containerRef.current) {
                return;
            }

            const term = new Terminal({
                cursorBlink: true,
                cursorStyle: 'block',
                scrollback: 5000,
                fontSize: 14,
                fontFamily: 'Consolas, "Courier New", monospace',
                allowProposedApi: true,
                theme: getTerminalTheme(themeType),
            });

            const fitAddon = new FitAddon();
            const searchAddon = new SearchAddon();
            const webLinksAddon = new WebLinksAddon();

            term.loadAddon(fitAddon);
            term.loadAddon(searchAddon);
            term.loadAddon(webLinksAddon);

            term.open(containerRef.current);

            // Try WebGL
            try {
                const webglAddon = new WebglAddon();
                webglAddon.onContextLoss(() => webglAddon.dispose());
                term.loadAddon(webglAddon);
            } catch {
                // fallback to default renderer
            }

            fitAddon.fit();

            // Send keystrokes to PTY
            term.onData(data => {
                send({ method: 'key', tabId, key: data });
            });

            // Copy on select
            term.onSelectionChange(() => {
                const selected = term.getSelection();
                if (selected.length) {
                    copyToClipboard(selected);
                }
            });

            // Keyboard shortcuts
            term.attachCustomKeyEventHandler(e => {
                if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) {
                    return true;
                }
                if (e.key === 'F') {
                    setSearchVisible(true);
                    return false;
                }
                if (e.key === 'V') {
                    getTextFromClipboard()
                        .then(text => {
                            if (text) {
                                send({ method: 'key', tabId, key: text });
                            } else {
                                setPasteVisible(true);
                            }
                        })
                        .catch(() => setPasteVisible(true));
                    return false;
                }
                return true;
            });

            termRef.current = term;
            fitAddonRef.current = fitAddon;
            searchAddonRef.current = searchAddon;

            // Send initial size
            send({ method: 'resize', tabId, cols: term.cols, rows: term.rows });

            return () => {
                term.dispose();
                termRef.current = null;
                fitAddonRef.current = null;
                searchAddonRef.current = null;
            };
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [tabId]);

        // Update theme dynamically
        useEffect(() => {
            if (termRef.current) {
                termRef.current.options.theme = getTerminalTheme(themeType);
            }
        }, [themeType]);

        // Right-click paste
        useEffect(() => {
            const container = containerRef.current;
            if (!container) {
                return;
            }

            const handler = (event: MouseEvent): void => {
                event.preventDefault();
                getTextFromClipboard()
                    .then(text => {
                        if (text) {
                            send({ method: 'key', tabId, key: text });
                        } else {
                            setPasteVisible(true);
                        }
                    })
                    .catch(() => setPasteVisible(true));
            };

            container.addEventListener('contextmenu', handler);
            return () => container.removeEventListener('contextmenu', handler);
        }, [tabId, send]);

        // Fit on visibility change
        useEffect(() => {
            if (visible && fitAddonRef.current && termRef.current) {
                // Delay to let the container become visible first
                const timer = setTimeout(() => {
                    fitAddonRef.current?.fit();
                    termRef.current?.focus();
                    if (termRef.current) {
                        send({ method: 'resize', tabId, cols: termRef.current.cols, rows: termRef.current.rows });
                    }
                }, 50);
                return () => clearTimeout(timer);
            }
        }, [visible, tabId, send]);

        // Window resize
        useEffect(() => {
            let timer: ReturnType<typeof setTimeout> | null = null;

            const handler = (): void => {
                if (timer) {
                    clearTimeout(timer);
                }
                timer = setTimeout(() => {
                    timer = null;
                    if (visible && fitAddonRef.current && termRef.current) {
                        fitAddonRef.current.fit();
                        send({ method: 'resize', tabId, cols: termRef.current.cols, rows: termRef.current.rows });
                    }
                }, 150);
            };

            window.addEventListener('resize', handler);
            return () => {
                window.removeEventListener('resize', handler);
                if (timer) {
                    clearTimeout(timer);
                }
            };
        }, [visible, tabId, send]);

        const handlePaste = useCallback(
            (text: string) => {
                send({ method: 'key', tabId, key: text });
                setPasteVisible(false);
                termRef.current?.focus();
            },
            [tabId, send],
        );

        const handleSearchClose = useCallback(() => {
            setSearchVisible(false);
            searchAddonRef.current?.clearDecorations();
            termRef.current?.focus();
        }, []);

        return (
            <div
                className="terminal-pane"
                style={{ display: visible ? 'flex' : 'none' }}
            >
                {searchVisible && searchAddonRef.current && (
                    <SearchBar
                        searchAddon={searchAddonRef.current}
                        onClose={handleSearchClose}
                    />
                )}
                {pasteVisible && (
                    <PasteDialog
                        onPaste={handlePaste}
                        onClose={() => {
                            setPasteVisible(false);
                            termRef.current?.focus();
                        }}
                    />
                )}
                <div
                    ref={containerRef}
                    className="terminal-container"
                />
            </div>
        );
    },
);

TerminalPane.displayName = 'TerminalPane';
