import { useEffect, useRef } from 'react';
import './PasteDialog.css';

interface PasteDialogProps {
    onPaste: (text: string) => void;
    onClose: () => void;
}

export function PasteDialog({ onPaste, onClose }: PasteDialogProps): React.JSX.Element {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        textareaRef.current?.focus();
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            onPaste(textareaRef.current?.value || '');
        } else if (e.key === 'Escape') {
            onClose();
        }
    };

    const handleOverlayClick = (e: React.MouseEvent): void => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    };

    return (
        <div
            className="paste-overlay"
            onClick={handleOverlayClick}
        >
            <div className="paste-box">
                <label>Paste text into terminal (Ctrl+V here, then press Send):</label>
                <textarea
                    ref={textareaRef}
                    className="paste-area"
                    onKeyDown={handleKeyDown}
                />
                <div className="paste-buttons">
                    <button
                        className="search-btn"
                        onClick={onClose}
                    >
                        Cancel
                    </button>
                    <button
                        className="search-btn paste-send-btn"
                        onClick={() => onPaste(textareaRef.current?.value || '')}
                    >
                        Send
                    </button>
                </div>
            </div>
        </div>
    );
}
