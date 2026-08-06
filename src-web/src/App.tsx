import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { TabBar } from './components/TabBar';
import { TerminalPane, type TerminalPaneHandle } from './components/TerminalPane';
import { detectThemeType, type ThemeType } from './theme';
import type { ServerMessage, Tab } from './types';
import './App.css';

/** The terminals of this browser tab are remembered here, so a reload can attach to the running shells */
const STORAGE_KEY = 'xterm.session';

interface StoredSession {
    tabs: { id: string; title: string }[];
    activeTabId: string | null;
}

let tabCounter = 0;

function createTabId(): string {
    // `randomUUID` is only available in a secure context (https or localhost)
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return `tab-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`;
}

function createTab(): Tab {
    tabCounter++;
    return {
        id: createTabId(),
        title: `Terminal ${tabCounter}`,
        ready: false,
    };
}

function loadSession(): StoredSession | null {
    try {
        const raw = window.sessionStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return null;
        }
        const stored = JSON.parse(raw) as StoredSession;
        const tabs = (stored?.tabs || []).filter(tab => tab?.id && tab?.title);
        if (!tabs.length) {
            return null;
        }
        // Continue the numbering of the terminals where it stopped
        tabCounter = tabs.reduce((max, tab) => {
            const num = parseInt(tab.title.replace(/^\D+/, ''), 10);
            return isFinite(num) && num > max ? num : max;
        }, 0);

        return { tabs, activeTabId: stored.activeTabId };
    } catch {
        return null;
    }
}

const storedSession = loadSession();
const initialTabs: Tab[] = storedSession
    ? storedSession.tabs.map(tab => ({ id: tab.id, title: tab.title, ready: false }))
    : [createTab()];
const initialActiveTabId =
    storedSession && initialTabs.some(tab => tab.id === storedSession.activeTabId)
        ? storedSession.activeTabId
        : initialTabs[0].id;

export default function App(): React.JSX.Element {
    const [tabs, setTabs] = useState<Tab[]>(initialTabs);
    const [activeTabId, setActiveTabId] = useState<string | null>(initialActiveTabId);
    const [themeType, setThemeType] = useState<ThemeType>(detectThemeType);
    const paneRefs = useRef<Map<string, TerminalPaneHandle>>(new Map());
    const tabsRef = useRef(tabs);

    useEffect(() => {
        tabsRef.current = tabs;
    });

    // Remember the terminals of this browser tab, so a reload can attach to the running shells
    useEffect(() => {
        try {
            const stored: StoredSession = {
                tabs: tabs.map(tab => ({ id: tab.id, title: tab.title })),
                activeTabId,
            };
            window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
        } catch {
            // e.g. private mode without storage - the terminals then simply start anew
        }
    }, [tabs, activeTabId]);

    const onMessage = useCallback((msg: ServerMessage) => {
        if (msg.method === 'data' && msg.tabId) {
            paneRefs.current.get(msg.tabId)?.write(msg.data);
        } else if (msg.method === 'created' && msg.tabId) {
            if (!msg.restored) {
                // A new shell was started - the old content of the terminal is obsolete
                paneRefs.current.get(msg.tabId)?.restore('');
            }
            setTabs(prev => prev.map(t => (t.id === msg.tabId ? { ...t, ready: true } : t)));
        } else if (msg.method === 'restore' && msg.tabId) {
            // The shell survived the disconnection - show what happened in the meantime
            paneRefs.current.get(msg.tabId)?.restore(msg.data);
        } else if (msg.method === 'closed' && msg.tabId) {
            setTabs(prev => prev.filter(t => t.id !== msg.tabId));
        }
    }, []);

    const onConnected = useCallback(() => {
        // Mark all tabs as not ready so the useEffect re-sends 'create' for them
        setTabs(prev => prev.map(t => ({ ...t, ready: false })));
    }, []);

    const { connected, send } = useWebSocket({ onMessage, onConnected });

    // Send 'create' for new tabs added while connected
    useEffect(() => {
        if (!connected) {
            return;
        }
        for (const tab of tabs) {
            if (!tab.ready) {
                send({ method: 'create', tabId: tab.id });
            }
        }
    }, [tabs, send, connected]);

    // Listen for ioBroker theme change via postMessage
    useEffect(() => {
        const handler = (event: MessageEvent): void => {
            if (event.data?.type === 'updateTheme') {
                setThemeType(detectThemeType(event.data?.themeName));
            }
        };

        window.addEventListener('message', handler, false);
        return () => window.removeEventListener('message', handler, false);
    }, []);

    // Listen for system color scheme changes
    useEffect(() => {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = (): void => {
            setThemeType(detectThemeType());
        };

        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);

    const addTab = useCallback(() => {
        const tab = createTab();
        setTabs(prev => [...prev, tab]);
        setActiveTabId(tab.id);
    }, []);

    const closeTab = useCallback(
        (tabId: string) => {
            send({ method: 'close', tabId });
            paneRefs.current.delete(tabId);
            setTabs(prev => {
                const filtered = prev.filter(t => t.id !== tabId);
                if (filtered.length === 0) {
                    const tab = createTab();
                    setActiveTabId(tab.id);
                    return [tab];
                }
                return filtered;
            });
            setActiveTabId(prev => {
                if (prev === tabId) {
                    const currentTabs = tabsRef.current;
                    const idx = currentTabs.findIndex(t => t.id === tabId);
                    const next = currentTabs[idx + 1] || currentTabs[idx - 1];
                    return next?.id ?? null;
                }
                return prev;
            });
        },
        [send],
    );

    const switchTab = useCallback((tabId: string) => {
        setActiveTabId(tabId);
    }, []);

    // Ctrl+Shift+T to add tab
    useEffect(() => {
        const handler = (e: KeyboardEvent): void => {
            if (e.ctrlKey && e.shiftKey && e.key === 'T') {
                e.preventDefault();
                addTab();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [addTab]);

    return (
        <div className={`app theme-${themeType} ${connected ? '' : 'disconnected'}`}>
            <TabBar
                tabs={tabs}
                activeTabId={activeTabId}
                onSwitch={switchTab}
                onAdd={addTab}
                onClose={closeTab}
            />
            <div className="terminals-container">
                {tabs.map(tab => (
                    <TerminalPane
                        key={tab.id}
                        tabId={tab.id}
                        visible={tab.id === activeTabId}
                        themeType={themeType}
                        send={send}
                        ref={handle => {
                            if (handle) {
                                paneRefs.current.set(tab.id, handle);
                            } else {
                                paneRefs.current.delete(tab.id);
                            }
                        }}
                    />
                ))}
            </div>
        </div>
    );
}
