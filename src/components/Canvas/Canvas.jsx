import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as fabric from 'fabric';
import {
    MousePointer2,
    Pencil,
    Highlighter,
    Eraser,
    Trash2,
    Plus,
    Square,
    Circle,
    Minus,
    RectangleHorizontal,
    Undo2,
    Redo2,
    Type,
    ChevronLeft,
    ChevronRight,
} from 'lucide-react';
import {
    emitCanvasFullSync,
    onCanvasFullSync,
    offCanvasFullSync,
    isConnected
} from '../../services/socket';

// simplified canvas for embedding in panels

// Preset colors
const PRESET_COLORS = [
    { name: 'White', hex: '#FFFFFF' },
    { name: 'Blue', hex: '#007AFF' },
    { name: 'Red', hex: '#FF3B30' },
    { name: 'Yellow', hex: '#FFCC00' },
    { name: 'Green', hex: '#34C759' },
];

// Tool types
const TOOLS = {
    SELECT: 'select',
    PEN: 'pen',
    HIGHLIGHTER: 'highlighter',
    ERASER: 'eraser',
    TEXT: 'text',
};

// Default tool settings
const DEFAULT_TOOL_SETTINGS = {
    [TOOLS.PEN]: { width: 3, color: '#FFFFFF' },
    [TOOLS.HIGHLIGHTER]: { width: 20, color: '#FFCC00' },
    [TOOLS.ERASER]: { width: 20 },
    [TOOLS.TEXT]: { color: '#FFFFFF', fontSize: 20 },
};

// Styles object (no styled-jsx)
const styles = {
    wrapper: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: '#1a1a1a',
        overflow: 'hidden',
    },
    canvasArea: {
        flex: 1,
        overflow: 'hidden',
    },
    toolbar: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '8px 12px',
        backgroundColor: '#141416',
        borderTop: '1px solid #333',
        flexWrap: 'wrap',
    },
    toolBtn: {
        width: '32px',
        height: '32px',
        border: 'none',
        background: '#222225',
        color: '#ccc',
        borderRadius: '6px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
    },
    toolBtnActive: {
        background: '#007AFF',
        color: '#fff',
    },
    toolBtnDisabled: {
        opacity: 0.4,
        cursor: 'not-allowed',
    },
    colorBtn: {
        width: '24px',
        height: '24px',
        border: '2px solid transparent',
        borderRadius: '50%',
        cursor: 'pointer',
    },
    colorBtnActive: {
        borderColor: '#007AFF',
        boxShadow: '0 0 0 2px rgba(0,122,255,0.3)',
    },
    divider: {
        width: '1px',
        height: '24px',
        background: '#444',
        margin: '0 4px',
    },
    shapesContainer: {
        position: 'relative',
    },
    shapesMenu: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        display: 'flex',
        gap: '4px',
        padding: '6px',
        background: '#1a1a1e',
        border: '1px solid #444',
        borderRadius: '8px',
        marginBottom: '4px',
    },
};

// eraser brush - uses destination-out
class EraserBrush extends fabric.PencilBrush {
    constructor(canvas) {
        super(canvas);
        this.color = 'rgba(0,0,0,1)';
        this.globalCompositeOperation = 'destination-out';
    }

    createPath(pathData) {
        const path = super.createPath(pathData);
        path.globalCompositeOperation = 'destination-out';
        path.stroke = 'rgba(0,0,0,1)';
        return path;
    }
}

const Canvas = ({ roomId }) => {
    const canvasRef = useRef(null);
    const fabricRef = useRef(null);
    const isInitialized = useRef(false);
    const containerRef = useRef(null);
    const isRemoteUpdate = useRef(false); // Prevent echo loops

    // Tool state
    const [activeTool, setActiveTool] = useState(TOOLS.PEN);
    const [toolSettings, setToolSettings] = useState(DEFAULT_TOOL_SETTINGS);
    const [showShapesMenu, setShowShapesMenu] = useState(false);
    const [isToolbarCollapsed, setIsToolbarCollapsed] = useState(false);

    // Undo/Redo state
    const [history, setHistory] = useState([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const isUndoRedo = useRef(false);

    // Get current tool's settings
    const currentToolSettings = toolSettings[activeTool] || {};
    const currentColor = currentToolSettings.color || '#FFFFFF';
    const currentWidth = currentToolSettings.width || 3;

    // Update tool settings
    const updateToolSettings = (tool, updates) => {
        setToolSettings(prev => ({
            ...prev,
            [tool]: { ...prev[tool], ...updates },
        }));
    };

    // Save to history
    const saveToHistory = useCallback(() => {
        if (!fabricRef.current || isUndoRedo.current) return;

        const canvas = fabricRef.current;
        const json = canvas.toJSON(['globalCompositeOperation']);

        setHistory(prev => {
            const newHistory = prev.slice(0, historyIndex + 1);
            newHistory.push(json);
            if (newHistory.length > 30) newHistory.shift();
            return newHistory;
        });
        setHistoryIndex(prev => Math.min(prev + 1, 29));
    }, [historyIndex]);

    // Undo
    const undo = useCallback(() => {
        if (historyIndex <= 0 || !fabricRef.current) return;

        isUndoRedo.current = true;
        const newIndex = historyIndex - 1;
        const state = history[newIndex];

        fabricRef.current.loadFromJSON(state, () => {
            fabricRef.current.renderAll();
            setHistoryIndex(newIndex);
            isUndoRedo.current = false;
        });
    }, [history, historyIndex]);

    // Redo
    const redo = useCallback(() => {
        if (historyIndex >= history.length - 1 || !fabricRef.current) return;

        isUndoRedo.current = true;
        const newIndex = historyIndex + 1;
        const state = history[newIndex];

        fabricRef.current.loadFromJSON(state, () => {
            fabricRef.current.renderAll();
            setHistoryIndex(newIndex);
            isUndoRedo.current = false;
        });
    }, [history, historyIndex]);

    // Initialize canvas
    useEffect(() => {
        if (isInitialized.current || !containerRef.current) return;

        const container = containerRef.current;
        const rect = container.getBoundingClientRect();

        fabricRef.current = new fabric.Canvas(canvasRef.current, {
            width: rect.width || 400,
            height: rect.height || 300,
            backgroundColor: '#1a1a1a',
            selection: true,
        });

        fabricRef.current.freeDrawingBrush = new fabric.PencilBrush(fabricRef.current);
        fabricRef.current.freeDrawingBrush.width = currentWidth;
        fabricRef.current.freeDrawingBrush.color = currentColor;
        fabricRef.current.isDrawingMode = true;

        isInitialized.current = true;

        // Save initial state
        setTimeout(() => {
            if (fabricRef.current) {
                const json = fabricRef.current.toJSON(['globalCompositeOperation']);
                setHistory([json]);
                setHistoryIndex(0);
            }
        }, 100);

        // Handle resize
        const handleResize = () => {
            if (fabricRef.current && containerRef.current) {
                const newRect = containerRef.current.getBoundingClientRect();
                fabricRef.current.setDimensions({
                    width: newRect.width,
                    height: newRect.height
                });
            }
        };

        const resizeObserver = new ResizeObserver(handleResize);
        resizeObserver.observe(container);

        return () => {
            resizeObserver.disconnect();
            if (fabricRef.current) {
                fabricRef.current.dispose();
                fabricRef.current = null;
                isInitialized.current = false;
            }
        };
    }, []);

    // Listen for path creation and broadcast individual objects
    useEffect(() => {
        if (!fabricRef.current) return;

        const canvas = fabricRef.current;

        // Broadcast individual object to other users
        const broadcastNewObject = (obj) => {
            if (!roomId || !isConnected() || isRemoteUpdate.current) return;
            // Send the object's JSON representation
            const objJSON = obj.toJSON(['globalCompositeOperation']);
            emitCanvasFullSync({
                type: 'add-object',
                object: objJSON
            });
        };

        const handlePathCreated = (e) => {
            saveToHistory();
            if (e.path && !isRemoteUpdate.current) {
                broadcastNewObject(e.path);
            }
        };

        const handleObjectAdded = (e) => {
            // Only broadcast user-added objects (not from undo/redo or remote)
            if (e.target && !isUndoRedo.current && !isRemoteUpdate.current) {
                // Skip if it's a path (handled by path:created)
                if (e.target.type !== 'path') {
                    broadcastNewObject(e.target);
                }
            }
        };

        const handleObjectModified = (e) => {
            if (!roomId || !isConnected() || isRemoteUpdate.current) return;
            saveToHistory();
            // For modifications, we send full state to ensure consistency
            const json = canvas.toJSON(['globalCompositeOperation']);
            emitCanvasFullSync({ type: 'full-sync', fabricJSON: json });
        };

        canvas.on('path:created', handlePathCreated);
        canvas.on('object:modified', handleObjectModified);
        canvas.on('object:added', handleObjectAdded);

        return () => {
            canvas.off('path:created', handlePathCreated);
            canvas.off('object:modified', handleObjectModified);
            canvas.off('object:added', handleObjectAdded);
        };
    }, [saveToHistory, roomId]);

    // Listen for remote canvas updates
    useEffect(() => {
        if (!roomId) return;

        const handleRemoteCanvasSync = async (data) => {
            console.log('remote canvas sync:', data.type);
            if (!fabricRef.current) return;

            isRemoteUpdate.current = true;
            const canvas = fabricRef.current;

            try {
                if (data.type === 'add-object' && data.object) {
                    // Add individual object to canvas using Fabric.js v6 API
                    // Use loadFromJSON for a wrapper with just the object
                    const wrapperJSON = {
                        version: '6.0.0',
                        objects: [data.object],
                        background: canvas.backgroundColor
                    };

                    // Get current objects first
                    const existingObjects = canvas.getObjects().map(obj => obj.toJSON(['globalCompositeOperation']));

                    // Merge with new object
                    wrapperJSON.objects = [...existingObjects, data.object];

                    canvas.loadFromJSON(wrapperJSON, () => {
                        canvas.renderAll();
                        isRemoteUpdate.current = false;
                        console.log('remote object added');
                    });
                } else if (data.type === 'full-sync' && data.fabricJSON) {
                    // Full sync for modifications or clear
                    canvas.loadFromJSON(data.fabricJSON, () => {
                        canvas.renderAll();
                        isRemoteUpdate.current = false;
                        console.log('remote canvas synced');
                    });
                } else if (data.type === 'clear') {
                    // Handle clear canvas
                    canvas.clear();
                    canvas.backgroundColor = '#1a1a1a';
                    canvas.renderAll();
                    isRemoteUpdate.current = false;
                } else if (data.fabricJSON) {
                    // Legacy: full sync for backward compatibility
                    canvas.loadFromJSON(data.fabricJSON, () => {
                        canvas.renderAll();
                        isRemoteUpdate.current = false;
                    });
                } else {
                    isRemoteUpdate.current = false;
                }
            } catch (error) {
                console.error('Canvas sync error:', error);
                isRemoteUpdate.current = false;
            }
        };

        onCanvasFullSync(handleRemoteCanvasSync);

        return () => {
            offCanvasFullSync(handleRemoteCanvasSync);
        };
    }, [roomId]);

    // Text tool handler
    useEffect(() => {
        if (!fabricRef.current) return;

        const canvas = fabricRef.current;

        const handleMouseDown = (e) => {
            if (activeTool === TOOLS.TEXT && !e.target) {
                const pointer = canvas.getPointer(e.e);
                const textSettings = toolSettings[TOOLS.TEXT] || { color: '#FFFFFF', fontSize: 20 };

                const text = new fabric.IText('Text', {
                    left: pointer.x,
                    top: pointer.y,
                    fontFamily: 'Arial, sans-serif',
                    fontSize: textSettings.fontSize || 20,
                    fill: textSettings.color,
                    editable: true,
                });

                canvas.add(text);
                canvas.setActiveObject(text);
                text.enterEditing();
                text.selectAll();
                canvas.renderAll();
                saveToHistory();
                setActiveTool(TOOLS.SELECT);
            }
        };

        if (activeTool === TOOLS.TEXT) {
            canvas.on('mouse:down', handleMouseDown);
        }

        return () => canvas.off('mouse:down', handleMouseDown);
    }, [activeTool, toolSettings, saveToHistory]);

    // Tool switching logic
    useEffect(() => {
        if (!fabricRef.current) return;

        const canvas = fabricRef.current;
        const settings = toolSettings[activeTool] || {};

        switch (activeTool) {
            case TOOLS.SELECT:
                canvas.isDrawingMode = false;
                canvas.selection = true;
                canvas.defaultCursor = 'default';
                canvas.forEachObject(obj => { obj.selectable = true; });
                break;

            case TOOLS.PEN:
                canvas.isDrawingMode = true;
                canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
                canvas.freeDrawingBrush.width = settings.width || 3;
                canvas.freeDrawingBrush.color = settings.color || '#FFFFFF';
                break;

            case TOOLS.HIGHLIGHTER:
                canvas.isDrawingMode = true;
                canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
                canvas.freeDrawingBrush.width = settings.width || 20;
                canvas.freeDrawingBrush.color = (settings.color || '#FFCC00') + '60';
                break;

            case TOOLS.ERASER:
                canvas.isDrawingMode = true;
                canvas.freeDrawingBrush = new EraserBrush(canvas);
                canvas.freeDrawingBrush.width = settings.width || 20;
                break;

            case TOOLS.TEXT:
                canvas.isDrawingMode = false;
                canvas.selection = false;
                canvas.defaultCursor = 'text';
                break;

            default:
                break;
        }

        canvas.renderAll();
    }, [activeTool, toolSettings]);

    // Shape functions
    const addShape = (shapeType) => {
        if (!fabricRef.current) return;

        const canvas = fabricRef.current;
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;

        let shape;

        switch (shapeType) {
            case 'square':
                shape = new fabric.Rect({
                    left: centerX - 40, top: centerY - 40,
                    width: 80, height: 80,
                    fill: 'transparent', stroke: '#FFFFFF', strokeWidth: 2,
                });
                break;
            case 'rectangle':
                shape = new fabric.Rect({
                    left: centerX - 60, top: centerY - 30,
                    width: 120, height: 60,
                    fill: 'transparent', stroke: '#FFFFFF', strokeWidth: 2,
                });
                break;
            case 'circle':
                shape = new fabric.Circle({
                    left: centerX - 40, top: centerY - 40, radius: 40,
                    fill: 'transparent', stroke: '#FFFFFF', strokeWidth: 2,
                });
                break;
            case 'line':
                shape = new fabric.Line([centerX - 50, centerY, centerX + 50, centerY], {
                    stroke: '#FFFFFF', strokeWidth: 2,
                });
                break;
            default:
                return;
        }

        if (shape) {
            canvas.add(shape);
            canvas.setActiveObject(shape);
            canvas.renderAll();
            saveToHistory();
            setActiveTool(TOOLS.SELECT);
            setShowShapesMenu(false);
        }
    };

    const clearCanvas = () => {
        if (!fabricRef.current) return;
        fabricRef.current.clear();
        fabricRef.current.backgroundColor = '#1a1a1a';
        fabricRef.current.renderAll();
        saveToHistory();

        // Broadcast clear event
        if (roomId && isConnected()) {
            emitCanvasFullSync({ type: 'clear' });
        }
    };

    const handleColorSelect = (color) => {
        if (activeTool === TOOLS.PEN) {
            updateToolSettings(TOOLS.PEN, { color });
        } else if (activeTool === TOOLS.HIGHLIGHTER) {
            updateToolSettings(TOOLS.HIGHLIGHTER, { color });
        } else if (activeTool === TOOLS.TEXT) {
            updateToolSettings(TOOLS.TEXT, { color });
        }
    };

    const canUndo = historyIndex > 0;
    const canRedo = historyIndex < history.length - 1;

    return (
        <div style={styles.wrapper}>
            {/* Canvas */}
            <div style={styles.canvasArea} ref={containerRef}>
                <canvas ref={canvasRef} />
            </div>

            {/* Toolbar */}
            <div style={styles.toolbar}>
                {/* Collapse/Expand Toggle */}
                <button
                    style={styles.toolBtn}
                    onClick={() => setIsToolbarCollapsed(!isToolbarCollapsed)}
                    title={isToolbarCollapsed ? 'Expand Toolbar' : 'Collapse Toolbar'}
                >
                    {isToolbarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
                </button>

                {/* Collapsible Section */}
                {!isToolbarCollapsed && (
                    <>
                        <div style={styles.divider} />

                        {/* Undo/Redo */}
                        <button
                            style={{ ...styles.toolBtn, ...(canUndo ? {} : styles.toolBtnDisabled) }}
                            onClick={undo}
                            disabled={!canUndo}
                            title="Undo"
                        >
                            <Undo2 size={16} />
                        </button>
                        <button
                            style={{ ...styles.toolBtn, ...(canRedo ? {} : styles.toolBtnDisabled) }}
                            onClick={redo}
                            disabled={!canRedo}
                            title="Redo"
                        >
                            <Redo2 size={16} />
                        </button>

                        <div style={styles.divider} />

                        {/* Tools */}
                        <button
                            style={{ ...styles.toolBtn, ...(activeTool === TOOLS.SELECT ? styles.toolBtnActive : {}) }}
                            onClick={() => setActiveTool(TOOLS.SELECT)}
                            title="Select"
                        >
                            <MousePointer2 size={16} />
                        </button>
                        <button
                            style={{ ...styles.toolBtn, ...(activeTool === TOOLS.PEN ? styles.toolBtnActive : {}) }}
                            onClick={() => setActiveTool(TOOLS.PEN)}
                            title="Pen"
                        >
                            <Pencil size={16} />
                        </button>
                        <button
                            style={{ ...styles.toolBtn, ...(activeTool === TOOLS.HIGHLIGHTER ? styles.toolBtnActive : {}) }}
                            onClick={() => setActiveTool(TOOLS.HIGHLIGHTER)}
                            title="Highlighter"
                        >
                            <Highlighter size={16} />
                        </button>
                        <button
                            style={{ ...styles.toolBtn, ...(activeTool === TOOLS.TEXT ? styles.toolBtnActive : {}) }}
                            onClick={() => setActiveTool(TOOLS.TEXT)}
                            title="Text"
                        >
                            <Type size={16} />
                        </button>
                        <button
                            style={{ ...styles.toolBtn, ...(activeTool === TOOLS.ERASER ? styles.toolBtnActive : {}) }}
                            onClick={() => setActiveTool(TOOLS.ERASER)}
                            title="Eraser"
                        >
                            <Eraser size={16} />
                        </button>

                        <div style={styles.divider} />

                        {/* Colors */}
                        {PRESET_COLORS.map((color) => (
                            <button
                                key={color.name}
                                style={{
                                    ...styles.colorBtn,
                                    backgroundColor: color.hex,
                                    ...(currentColor === color.hex ? styles.colorBtnActive : {})
                                }}
                                onClick={() => handleColorSelect(color.hex)}
                                title={color.name}
                            />
                        ))}

                        <div style={styles.divider} />

                        {/* Shapes */}
                        <div style={styles.shapesContainer}>
                            <button
                                style={{ ...styles.toolBtn, ...(showShapesMenu ? styles.toolBtnActive : {}) }}
                                onClick={() => setShowShapesMenu(!showShapesMenu)}
                                title="Shapes"
                            >
                                <Plus size={16} />
                            </button>
                            {showShapesMenu && (
                                <div style={styles.shapesMenu}>
                                    <button style={styles.toolBtn} onClick={() => addShape('square')}><Square size={14} /></button>
                                    <button style={styles.toolBtn} onClick={() => addShape('rectangle')}><RectangleHorizontal size={14} /></button>
                                    <button style={styles.toolBtn} onClick={() => addShape('circle')}><Circle size={14} /></button>
                                    <button style={styles.toolBtn} onClick={() => addShape('line')}><Minus size={14} /></button>
                                </div>
                            )}
                        </div>

                        {/* Clear */}
                        <button
                            style={styles.toolBtn}
                            onClick={clearCanvas}
                            title="Clear Canvas"
                        >
                            <Trash2 size={16} />
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};

export default Canvas;

