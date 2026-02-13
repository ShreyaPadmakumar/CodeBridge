import { Minus, Square, X } from 'lucide-react';

export default function Panel({
    title,
    icon,
    children,
    isMinimized = false,
    isMaximized = false,
    isHidden = false,
    onMinimize,
    onMaximize,
    onClose,
    className = ''
}) {
    if (isHidden) return null;

    return (
        <div
            className={`
        panel 
        ${isMinimized ? 'panel-minimized' : ''} 
        ${isMaximized ? 'panel-maximized' : ''} 
        ${className}
      `}
        >
            {/* Panel Header */}
            <div className="panel-header">
                <div className="panel-title">
                    {icon}
                    <span>{title}</span>
                </div>
                <div className="panel-controls">
                    <button
                        onClick={onMinimize}
                        title={isMinimized ? "Restore" : "Minimize"}
                        className="panel-control-btn"
                    >
                        <Minus size={12} />
                    </button>
                    <button
                        onClick={onMaximize}
                        title={isMaximized ? "Restore" : "Maximize"}
                        className="panel-control-btn"
                    >
                        <Square size={10} />
                    </button>
                    <button
                        onClick={onClose}
                        title="Close"
                        className="panel-control-btn panel-close-btn"
                    >
                        <X size={12} />
                    </button>
                </div>
            </div>

            {/* Panel Content */}
            {!isMinimized && (
                <div className="panel-content">
                    {children}
                </div>
            )}
        </div>
    );
}
