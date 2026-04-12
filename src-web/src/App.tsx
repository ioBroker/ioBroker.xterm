import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { TabBar } from './components/TabBar';
import { TerminalPane, type TerminalPaneHandle } from './components/TerminalPane';
import { detectThemeType, type ThemeType } from './theme';
import type { ServerMessage, Tab } from './types';
import './App.css';

let tabCounter = 0;

function createTab(): Tab {
    tabCounter++;
    return {
        id: crypto.randomUUID ? crypto.randomUUID() : `tab-${tabCounter}`,
        title: `Terminal ${tabCounter}`,
        ready: false,
    };
}

const initialTab = createTab();

export default function App(): React.JSX.Element {
    const [tabs, setTabs] = useState<Tab[]>([initialTab]);
    const [activeTabId, setActiveTabId] = useState<string | null>(initialTab.id);
    const [themeType, setThemeType] = useState<ThemeType>(detectThemeType);
    const paneRefs = useRef<Map<string, TerminalPaneHandle>>(new Map());
    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;

    const sendRef = useRef<(msg: import('./types').ClientMessage) => void>(() => {});

    const onMessage = useCallback((msg: ServerMessage) => {
        if (msg.method === 'data' && msg.tabId) {
            paneRefs.current.get(msg.tabId)?.write(msg.data);
        } else if (msg.method === 'created' && msg.tabId) {
            setTabs(prev => prev.map(t => (t.id === msg.tabId ? { ...t, ready: true } : t)));
        } else if (msg.method === 'closed' && msg.tabId) {
            setTabs(prev => prev.filter(t => t.id !== msg.tabId));
        }
    }, []);

    const onConnected = useCallback(() => {
        // Send 'create' for all existing tabs on (re)connect
        const currentTabs = tabsRef.current;
        // Mark all tabs as not ready so they get re-created
        setTabs(prev => prev.map(t => ({ ...t, ready: false })));
        for (const tab of currentTabs) {
            sendRef.current({ method: 'create', tabId: tab.id });
        }
    }, []);

    const { connected, send } = useWebSocket({ onMessage, onConnected });
    sendRef.current = send;

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
