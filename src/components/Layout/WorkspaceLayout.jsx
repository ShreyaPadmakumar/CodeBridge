import { useState, useCallback } from 'react';
import { Code2, Terminal, Palette, Eye, EyeOff } from 'lucide-react';
import Panel from '../Shared/Panel';
import CodeEditor from '../CodeEditor';
import TerminalPanel from '../CodeEditor/TerminalPanel';
import Canvas from '../Canvas/CanvasFull';

export default function WorkspaceLayout({
    // Code execution props
    isExecuting,
    terminalHistory,
    currentFilename,
    stdin,
    onStdinChange,
    onExecuteWithStdin,
    onClearTerminal,
    onCodeChange,
    onExecute,
    // Room props
    roomId = '',
    roomUsers = [],
    initialState = null
}) {
    // Panel visibility states
    const [panelStates, setPanelStates] = useState({
        codeEditor: { minimized: false, maximized: false, hidden: false },
        terminal: { minimized: false, maximized: false, hidden: false },
        canvas: { minimized: false, maximized: false, hidden: false }
    });

    // Toggle panel state
    const togglePanelState = useCallback((panelId, state) => {
        setPanelStates(prev => {
            const current = prev[panelId];

            // If maximizing, minimize the maximize state of others
            if (state === 'maximized' && !current.maximized) {
                const newStates = { ...prev };
                Object.keys(newStates).forEach(key => {
                    newStates[key] = { ...newStates[key], maximized: false };
                });
                newStates[panelId] = { ...current, maximized: true, minimized: false };
                return newStates;
            }

            return {
                ...prev,
                [panelId]: {
                    ...current,
                    [state]: !current[state],
                    // If minimizing, can't be maximized
                    ...(state === 'minimized' && !current.minimized ? { maximized: false } : {}),
                    // If maximizing, can't be minimized
                    ...(state === 'maximized' && !current.maximized ? { minimized: false } : {})
                }
            };
        });
    }, []);

    // Close panel (hide it)
    const closePanel = useCallback((panelId) => {
        // Count visible panels
        const visibleCount = Object.values(panelStates).filter(p => !p.hidden).length;

        // Don't close if it's the last visible panel
        if (visibleCount <= 1) {
            console.log('Cannot close last panel');
            return;
        }

        setPanelStates(prev => ({
            ...prev,
            [panelId]: { ...prev[panelId], hidden: true, maximized: false }
        }));
    }, [panelStates]);

    // Reopen panel
    const reopenPanel = useCallback((panelId) => {
        setPanelStates(prev => ({
            ...prev,
            [panelId]: { ...prev[panelId], hidden: false }
        }));
    }, []);

    // Check if any panel is maximized
    const hasMaximizedPanel = Object.values(panelStates).some(p => p.maximized);

    // Get hidden panels
    const hiddenPanels = Object.entries(panelStates)
        .filter(([_, state]) => state.hidden)
        .map(([id]) => id);

    // Calculate panel heights for right side
    const getTerminalHeight = () => {
        if (panelStates.terminal.minimized) return '40px';
        if (panelStates.canvas.minimized) return 'calc(100% - 48px)';
        if (panelStates.canvas.hidden) return '100%';
        return '35%';
    };

    const getCanvasHeight = () => {
        if (panelStates.canvas.minimized) return '40px';
        if (panelStates.terminal.minimized) return 'calc(100% - 48px)';
        if (panelStates.terminal.hidden) return '100%';
        return '65%';
    };

    return (
        <div className="workspace">
            {/* Hidden Panels Restore Buttons */}
            {hiddenPanels.length > 0 && (
                <div className="hidden-panels-bar">
                    <span className="hidden-panels-label">
                        <EyeOff size={14} />
                        Hidden:
                    </span>
                    {hiddenPanels.includes('codeEditor') && (
                        <button onClick={() => reopenPanel('codeEditor')} className="reopen-btn">
                            <Code2 size={14} /> Code Editor
                        </button>
                    )}
                    {hiddenPanels.includes('terminal') && (
                        <button onClick={() => reopenPanel('terminal')} className="reopen-btn">
                            <Terminal size={14} /> Terminal
                        </button>
                    )}
                    {hiddenPanels.includes('canvas') && (
                        <button onClick={() => reopenPanel('canvas')} className="reopen-btn">
                            <Palette size={14} /> Canvas
                        </button>
                    )}
                </div>
            )}

            {/* Main Workspace Area */}
            <div className="workspace-main">
                {/* Left Side - Code Editor */}
                {!panelStates.codeEditor.hidden && (
                    <div
                        className="workspace-left"
                        style={{
                            width: panelStates.codeEditor.maximized ? '100%' :
                                panelStates.codeEditor.minimized ? '40px' : '50%',
                            display: hasMaximizedPanel && !panelStates.codeEditor.maximized ? 'none' : 'flex'
                        }}
                    >
                        <Panel
                            title="Code Editor"
                            icon={<Code2 size={16} className="text-[#6e7bf2]" />}
                            isMinimized={panelStates.codeEditor.minimized}
                            isMaximized={panelStates.codeEditor.maximized}
                            onMinimize={() => togglePanelState('codeEditor', 'minimized')}
                            onMaximize={() => togglePanelState('codeEditor', 'maximized')}
                            onClose={() => closePanel('codeEditor')}
                            className="h-full"
                        >
                            <CodeEditor
                                roomId={roomId}
                                onCodeChange={onCodeChange}
                                onExecute={onExecute}
                                isExecuting={isExecuting}
                                initialRoomState={initialState}
                            />
                        </Panel>
                    </div>
                )}

                {/* Right Side - Terminal + Canvas */}
                <div
                    className="workspace-right"
                    style={{
                        width: panelStates.codeEditor.hidden ? '100%' :
                            panelStates.codeEditor.minimized ? 'calc(100% - 48px)' : '50%',
                        display: hasMaximizedPanel && panelStates.codeEditor.maximized ? 'none' : 'flex'
                    }}
                >
                    {/* Terminal Panel */}
                    {!panelStates.terminal.hidden && (
                        <div
                            className="workspace-right-top"
                            style={{
                                height: panelStates.terminal.maximized ? '100%' : getTerminalHeight(),
                                display: hasMaximizedPanel && !panelStates.terminal.maximized ? 'none' : 'block'
                            }}
                        >
                            <Panel
                                title="Terminal"
                                icon={<Terminal size={16} className="text-[#3ecf71]" />}
                                isMinimized={panelStates.terminal.minimized}
                                isMaximized={panelStates.terminal.maximized}
                                onMinimize={() => togglePanelState('terminal', 'minimized')}
                                onMaximize={() => togglePanelState('terminal', 'maximized')}
                                onClose={() => closePanel('terminal')}
                                className="h-full"
                            >
                                <TerminalPanel
                                    isExecuting={isExecuting}
                                    terminalHistory={terminalHistory}
                                    onClear={onClearTerminal}
                                    currentFilename={currentFilename}
                                    stdin={stdin}
                                    onStdinChange={onStdinChange}
                                    onExecuteWithStdin={onExecuteWithStdin}
                                />
                            </Panel>
                        </div>
                    )}

                    {/* Canvas Panel */}
                    {!panelStates.canvas.hidden && (
                        <div
                            className="workspace-right-bottom"
                            style={{
                                height: panelStates.canvas.maximized ? '100%' : getCanvasHeight(),
                                display: hasMaximizedPanel && !panelStates.canvas.maximized ? 'none' : 'block'
                            }}
                        >
                            <Panel
                                title="Canvas"
                                icon={<Palette size={16} className="text-[#f0a641]" />}
                                isMinimized={panelStates.canvas.minimized}
                                isMaximized={panelStates.canvas.maximized}
                                onMinimize={() => togglePanelState('canvas', 'minimized')}
                                onMaximize={() => togglePanelState('canvas', 'maximized')}
                                onClose={() => closePanel('canvas')}
                                className="h-full"
                            >
                                <Canvas
                                    roomUsers={roomUsers}
                                    roomId={roomId}
                                    initialState={initialState}
                                />
                            </Panel>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
