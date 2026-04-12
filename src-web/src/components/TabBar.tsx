import type { Tab } from '../types';
import './TabBar.css';

interface TabBarProps {
    tabs: Tab[];
    activeTabId: string | null;
    onSwitch: (tabId: string) => void;
    onAdd: () => void;
    onClose: (tabId: string) => void;
}

export function TabBar({ tabs, activeTabId, onSwitch, onAdd, onClose }: TabBarProps): React.JSX.Element {
    return (
        <div className="tab-bar">
            {tabs.map(tab => (
                <div
                    key={tab.id}
                    className={`tab ${tab.id === activeTabId ? 'tab-active' : ''}`}
                    onClick={() => onSwitch(tab.id)}
                >
                    <span className="tab-title">{tab.title}</span>
                    {tabs.length > 1 && (
                        <button
                            className="tab-close"
                            onClick={e => {
                                e.stopPropagation();
                                onClose(tab.id);
                            }}
                        >
                            &#10005;
                        </button>
                    )}
                </div>
            ))}
            <button
                className="tab-add"
                onClick={onAdd}
                title="New terminal (Ctrl+Shift+T)"
            >
                +
            </button>
        </div>
    );
}
