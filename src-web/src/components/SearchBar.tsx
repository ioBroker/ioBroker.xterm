import { useEffect, useRef } from 'react';
import type { SearchAddon } from '@xterm/addon-search';
import './SearchBar.css';

interface SearchBarProps {
    searchAddon: SearchAddon;
    onClose: () => void;
}

export function SearchBar({ searchAddon, onClose }: SearchBarProps): React.JSX.Element {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === 'Enter') {
            if (e.shiftKey) {
                searchAddon.findPrevious(inputRef.current?.value || '');
            } else {
                searchAddon.findNext(inputRef.current?.value || '');
            }
        } else if (e.key === 'Escape') {
            onClose();
        }
    };

    return (
        <div className="search-bar">
            <input
                ref={inputRef}
                className="search-input"
                type="text"
                placeholder="Search..."
                onKeyDown={handleKeyDown}
            />
            <button
                className="search-btn"
                onClick={() => searchAddon.findPrevious(inputRef.current?.value || '')}
            >
                &#9650;
            </button>
            <button
                className="search-btn"
                onClick={() => searchAddon.findNext(inputRef.current?.value || '')}
            >
                &#9660;
            </button>
            <button
                className="search-btn"
                onClick={onClose}
            >
                &#10005;
            </button>
        </div>
    );
}
