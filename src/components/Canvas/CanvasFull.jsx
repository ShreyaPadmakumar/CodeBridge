import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as fabric from 'fabric';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
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
    ArrowRight,
    RectangleHorizontal,
    Download,
    Sun,
    Moon,
    Grid3X3,
    Undo2,
    Redo2,
    Palette,
    Type,
    FileText,
    FilePlus,
    Check,
    X,
    Wifi,
    WifiOff,
    Users,
} from 'lucide-react';

// Socket.io service - only for connection status (no canvas sync)
import {
    isConnected,
    getSocketId,
    getSocket,
    emitCanvasFullSync,
    onCanvasFullSync,
    offCanvasFullSync,
    sendCanvasPathCreate,
    sendCanvasObjectAdd,
    sendCanvasObjectModify,
    onCanvasPathCreate,
    onCanvasObjectAdd,
    onCanvasObjectModify,
    onCanvasObjectDelete,
    onCanvasFileCreate,
    onCanvasFileSwitch,
    sendCanvasFileCreate,
    sendCanvasFileSwitch,
} from '../../services/socket';


// Preset colors
const PRESET_COLORS = [
    { name: 'Black', hex: '#000000' },
    { name: 'White', hex: '#FFFFFF' },
    { name: 'Blue', hex: '#007AFF' },
    { name: 'Red', hex: '#FF3B30' },
    { name: 'Yellow', hex: '#FFCC00' },
];

// Highlighter colors
const HIGHLIGHTER_COLORS = [
    { name: 'Yellow', hex: '#FFCC00' },
    { name: 'Green', hex: '#34C759' },
    { name: 'Blue', hex: '#5AC8FA' },
    { name: 'Pink', hex: '#FF2D55' },
    { name: 'Orange', hex: '#FF9500' },
];

// Background modes
const BACKGROUND_MODES = {
    PLAIN: 'plain',
    RULED: 'ruled',
    GRID: 'grid',
};

// Tool types
const TOOLS = {
    SELECT: 'select',
    PEN: 'pen',
    HIGHLIGHTER: 'highlighter',
    ERASER: 'eraser',
    OBJECT_ERASER: 'objectEraser',
    ARROW: 'arrow',
    TEXT: 'text',
};

// Default tool settings
const DEFAULT_TOOL_SETTINGS = {
    [TOOLS.PEN]: { width: 5, color: '#000000' },
    [TOOLS.HIGHLIGHTER]: { width: 30, color: '#FFCC00' },
    [TOOLS.ERASER]: { width: 20 },
    [TOOLS.ARROW]: { width: 2, color: '#000000' },
    [TOOLS.TEXT]: { color: '#000000', fontSize: 24 },
};

// Canvas dimensions
const INITIAL_CANVAS_HEIGHT = 2000;
const CANVAS_HEIGHT_INCREMENT = 500;
const BOTTOM_THRESHOLD = 100;

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

// Generate unique ID
const generateId = () => Date.now() + Math.random().toString(36).substr(2, 9);

// Create empty file
const createNewFile = (name = null) => ({
    id: generateId(),
    name: name || `Untitled ${Date.now() % 1000}`,
    data: null,
    createdAt: Date.now(),
});

const Canvas = ({ roomUsers = [], roomId = '', initialState = null }) => {
    const canvasRef = useRef(null);
    const fabricRef = useRef(null);
    const isInitialized = useRef(false);
    const containerRef = useRef(null);
    const wrapperRef = useRef(null);
    const isRemoteUpdate = useRef(false); // Flag to prevent echo loops

    // Arrow drawing state
    const arrowStartPoint = useRef(null);
    const isDrawingArrow = useRef(false);
    const tempArrowLine = useRef(null);

    // Tool state
    const [activeTool, setActiveTool] = useState(TOOLS.PEN);
    const [toolSettings, setToolSettings] = useState(DEFAULT_TOOL_SETTINGS);
    const [showColorPicker, setShowColorPicker] = useState(false);
    const [customColor, setCustomColor] = useState('#007AFF');

    // UI state
    const [showShapesMenu, setShowShapesMenu] = useState(false);
    const [toolbarPosition, setToolbarPosition] = useState({ x: null, y: null });
    const [backgroundMode, setBackgroundMode] = useState(BACKGROUND_MODES.PLAIN);
    const [darkMode, setDarkMode] = useState(false);
    const [canvasHeight, setCanvasHeight] = useState(INITIAL_CANVAS_HEIGHT);
    const [isExporting, setIsExporting] = useState(false);
    const [sidebarExpanded, setSidebarExpanded] = useState(true);

    // File management state
    const [files, setFiles] = useState(
        initialState?.canvasFiles && initialState.canvasFiles.length > 0
            ? initialState.canvasFiles
            : [createNewFile('Untitled 1')]
    );
    const [activeFileId, setActiveFileId] = useState(
        initialState?.activeCanvasFileId && files.find(f => f.id === initialState.activeCanvasFileId)
            ? initialState.activeCanvasFileId
            : files[0].id
    );
    const [editingFileId, setEditingFileId] = useState(null);
    const [editingFileName, setEditingFileName] = useState('');

    // Undo/Redo state
    const [history, setHistory] = useState([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const isUndoRedo = useRef(false);

    // Get current tool's settings
    const currentToolSettings = toolSettings[activeTool] || {};
    const currentColor = currentToolSettings.color || '#000000';
    const currentWidth = currentToolSettings.width || 5;

    // Update tool settings
    const updateToolSettings = (tool, updates) => {
        setToolSettings(prev => ({
            ...prev,
            [tool]: { ...prev[tool], ...updates },
        }));
    };

    // Get background color
    const getBackgroundColor = useCallback(() => {
        return darkMode ? '#1a1a1a' : '#ffffff';
    }, [darkMode]);

    // Color helpers
    const isBlackColor = (color) => {
        if (!color) return false;
        const c = color.toLowerCase();
        return c === '#000000' || c === '#000' || c === 'black';
    };

    const isWhiteColor = (color) => {
        if (!color) return false;
        const c = color.toLowerCase();
        return c === '#ffffff' || c === '#fff' || c === 'white';
    };

    // Smart color inversion for dark mode
    const invertObjectColors = useCallback((toDarkMode) => {
        if (!fabricRef.current) return;

        const canvas = fabricRef.current;
        canvas.getObjects().forEach(obj => {
            if (obj.globalCompositeOperation === 'destination-out') return;

            if (obj.stroke) {
                if (toDarkMode && isBlackColor(obj.stroke)) {
                    obj.set('stroke', '#ffffff');
                } else if (!toDarkMode && isWhiteColor(obj.stroke)) {
                    obj.set('stroke', '#000000');
                }
            }

            if (obj.fill && obj.fill !== 'transparent') {
                if (toDarkMode && isBlackColor(obj.fill)) {
                    obj.set('fill', '#ffffff');
                } else if (!toDarkMode && isWhiteColor(obj.fill)) {
                    obj.set('fill', '#000000');
                }
            }
        });

        canvas.renderAll();
    }, []);

    // Toggle dark mode
    const toggleDarkMode = useCallback(() => {
        const newDarkMode = !darkMode;
        setDarkMode(newDarkMode);
        invertObjectColors(newDarkMode);

        if (newDarkMode && isBlackColor(toolSettings[TOOLS.PEN].color)) {
            updateToolSettings(TOOLS.PEN, { color: '#ffffff' });
            updateToolSettings(TOOLS.TEXT, { color: '#ffffff' });
        } else if (!newDarkMode && isWhiteColor(toolSettings[TOOLS.PEN].color)) {
            updateToolSettings(TOOLS.PEN, { color: '#000000' });
            updateToolSettings(TOOLS.TEXT, { color: '#000000' });
        }
    }, [darkMode, invertObjectColors, toolSettings]);

    // Generate CSS background pattern
    const getBackgroundPattern = useCallback(() => {
        const bgColor = getBackgroundColor();
        const lineColor = darkMode ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)';

        if (backgroundMode === BACKGROUND_MODES.RULED) {
            return {
                backgroundColor: bgColor,
                backgroundImage: `repeating-linear-gradient(
          0deg,
          transparent,
          transparent 29px,
          ${lineColor} 29px,
          ${lineColor} 30px
        )`,
                backgroundSize: '100% 30px',
                backgroundPosition: '0 10px',
            };
        } else if (backgroundMode === BACKGROUND_MODES.GRID) {
            return {
                backgroundColor: bgColor,
                backgroundImage: `
          linear-gradient(${lineColor} 1px, transparent 1px),
          linear-gradient(90deg, ${lineColor} 1px, transparent 1px)
        `,
                backgroundSize: '25px 25px',
            };
        }

        return { backgroundColor: bgColor };
    }, [backgroundMode, darkMode, getBackgroundColor]);

    // Extend canvas (infinite canvas)
    const extendCanvasIfNeeded = useCallback((obj) => {
        if (!fabricRef.current || !obj) return;

        const canvas = fabricRef.current;
        const objBottom = obj.top + (obj.height * (obj.scaleY || 1));

        if (objBottom > canvas.height - BOTTOM_THRESHOLD) {
            const newHeight = canvas.height + CANVAS_HEIGHT_INCREMENT;
            canvas.setDimensions({ height: newHeight });
            setCanvasHeight(newHeight);
        }
    }, []);

    // Save to history
    const saveToHistory = useCallback(() => {
        if (!fabricRef.current || isUndoRedo.current) return;

        const canvas = fabricRef.current;
        const json = canvas.toJSON(['globalCompositeOperation']);

        setHistory(prev => {
            const newHistory = prev.slice(0, historyIndex + 1);
            newHistory.push(json);
            if (newHistory.length > 50) newHistory.shift();
            return newHistory;
        });
        setHistoryIndex(prev => Math.min(prev + 1, 49));
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

    // Dock toolbar
    const dockToolbar = useCallback(() => {
        setToolbarPosition({ x: null, y: null });
    }, []);

    // Create smart arrow
    const createSmartArrow = useCallback((x1, y1, x2, y2) => {
        if (!fabricRef.current) return null;

        const settings = toolSettings[TOOLS.ARROW] || { width: 2, color: '#000000' };
        const strokeColor = darkMode && isBlackColor(settings.color) ? '#ffffff' : settings.color;
        const angle = Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI);

        const line = new fabric.Line([x1, y1, x2, y2], {
            stroke: strokeColor,
            strokeWidth: settings.width,
            selectable: false,
        });

        const headSize = 12 + settings.width * 2;
        const triangle = new fabric.Triangle({
            left: x2,
            top: y2,
            width: headSize,
            height: headSize,
            fill: strokeColor,
            angle: angle + 90,
            originX: 'center',
            originY: 'center',
            selectable: false,
        });

        return new fabric.Group([line, triangle], {
            selectable: true,
            evented: true,
        });
    }, [darkMode, toolSettings]);

    // Save current canvas to active file
    const saveCurrentCanvas = useCallback(() => {
        if (!fabricRef.current) return;

        const json = fabricRef.current.toJSON(['globalCompositeOperation']);
        setFiles(prev => prev.map(f =>
            f.id === activeFileId ? { ...f, data: json } : f
        ));
    }, [activeFileId]);

    // Switch to a different file
    const switchToFile = useCallback((fileId) => {
        if (fileId === activeFileId || !fabricRef.current) return;

        // Save current canvas first
        saveCurrentCanvas();

        // Find target file
        const targetFile = files.find(f => f.id === fileId);
        if (!targetFile) return;

        // Clear and load target file's data
        const canvas = fabricRef.current;

        if (targetFile.data) {
            canvas.loadFromJSON(targetFile.data, () => {
                canvas.renderAll();
            });
        } else {
            canvas.clear();
            canvas.backgroundColor = 'transparent';
            canvas.renderAll();
        }

        // Update active file
        setActiveFileId(fileId);

        // Join the new file's socket room
        const sock = getSocket();
        sock.emit('join-file', { fileId, fileName: targetFile?.name });

        // Reset history for the new file
        setHistory([]);
        setHistoryIndex(-1);
        setTimeout(() => {
            if (fabricRef.current) {
                const json = fabricRef.current.toJSON(['globalCompositeOperation']);
                setHistory([json]);
                setHistoryIndex(0);
            }
        }, 100);
    }, [activeFileId, files, saveCurrentCanvas]);

    // Create new file
    const createFile = useCallback(() => {
        // Save current canvas first
        saveCurrentCanvas();

        // Create new file
        const newFile = createNewFile();
        setFiles(prev => [...prev, newFile]);

        // Broadcast file creation to other users
        const sock = getSocket();
        sock.emit('file-created', {
            id: newFile.id,
            name: newFile.name,
            createdAt: newFile.createdAt,
        });

        // Switch to new file
        if (fabricRef.current) {
            fabricRef.current.clear();
            fabricRef.current.backgroundColor = 'transparent';
            fabricRef.current.renderAll();
        }

        setActiveFileId(newFile.id);
        setHistory([]);
        setHistoryIndex(-1);

        // Join the new file's room
        sock.emit('join-file', { fileId: newFile.id, fileName: newFile.name });

        setTimeout(() => {
            if (fabricRef.current) {
                const json = fabricRef.current.toJSON(['globalCompositeOperation']);
                setHistory([json]);
                setHistoryIndex(0);
            }
        }, 100);
    }, [saveCurrentCanvas]);

    // Delete file
    const deleteFile = useCallback((fileId) => {
        if (files.length <= 1) return; // Keep at least one file

        const fileIndex = files.findIndex(f => f.id === fileId);
        const newFiles = files.filter(f => f.id !== fileId);
        setFiles(newFiles);

        // If deleting active file, switch to another
        if (fileId === activeFileId) {
            const newActiveIndex = Math.min(fileIndex, newFiles.length - 1);
            const newActiveFile = newFiles[newActiveIndex];

            if (newActiveFile.data && fabricRef.current) {
                fabricRef.current.loadFromJSON(newActiveFile.data, () => {
                    fabricRef.current.renderAll();
                });
            } else if (fabricRef.current) {
                fabricRef.current.clear();
                fabricRef.current.backgroundColor = 'transparent';
                fabricRef.current.renderAll();
            }

            setActiveFileId(newActiveFile.id);
        }
    }, [files, activeFileId]);

    // Start renaming file
    const startRenaming = (fileId, currentName) => {
        setEditingFileId(fileId);
        setEditingFileName(currentName);
    };

    // Finish renaming file
    const finishRenaming = () => {
        if (editingFileId && editingFileName.trim()) {
            setFiles(prev => prev.map(f =>
                f.id === editingFileId ? { ...f, name: editingFileName.trim() } : f
            ));

            // Broadcast rename to other users
            const sock = getSocket();
            sock.emit('file-renamed', {
                id: editingFileId,
                name: editingFileName.trim(),
            });
        }
        setEditingFileId(null);
        setEditingFileName('');
    };

    // Cancel renaming
    const cancelRenaming = () => {
        setEditingFileId(null);
        setEditingFileName('');
    };

    // Export to PDF using html2canvas (DOM Screenshot) - JPEG optimized
    const exportToPDF = useCallback(async () => {
        const canvasStage = document.getElementById('canvas-stage');
        if (!canvasStage) return;

        // Prompt for custom file name
        const activeFile = files.find(f => f.id === activeFileId);
        const defaultName = activeFile ? activeFile.name : 'canvas-export';
        const customName = window.prompt('Enter file name:', defaultName);

        // If user cancels, do nothing
        if (customName === null) return;

        const fileName = customName.trim() || defaultName;

        setIsExporting(true);

        try {
            if (fabricRef.current) {
                fabricRef.current.discardActiveObject();
                fabricRef.current.renderAll();
            }

            const stageHeight = canvasStage.offsetHeight;
            if (stageHeight > 5000) {
                console.warn(`Canvas is very tall (${stageHeight}px). Export may take a moment...`);
            }

            const snapshot = await html2canvas(canvasStage, {
                scale: 2,
                useCORS: true,
                logging: false,
                backgroundColor: getBackgroundColor(),
            });

            const imgData = snapshot.toDataURL('image/jpeg', 0.8);
            const imgWidth = snapshot.width;
            const imgHeight = snapshot.height;

            const pdf = new jsPDF({
                orientation: imgWidth > imgHeight ? 'landscape' : 'portrait',
                unit: 'px',
                format: [imgWidth / 2, imgHeight / 2],
            });

            pdf.addImage(imgData, 'JPEG', 0, 0, imgWidth / 2, imgHeight / 2);
            pdf.save(`${fileName}.pdf`);
        } catch (error) {
            console.error('PDF export failed:', error);
            alert('PDF export failed. Canvas may be too large.');
        } finally {
            setIsExporting(false);
        }
    }, [getBackgroundColor, files, activeFileId]);

    // Initialize canvas
    useEffect(() => {
        if (isInitialized.current) return;

        const container = containerRef.current;
        const sidebarWidth = sidebarExpanded ? 200 : 64;
        const width = container ? container.offsetWidth - sidebarWidth - 40 : window.innerWidth - sidebarWidth - 40;

        fabricRef.current = new fabric.Canvas(canvasRef.current, {
            width,
            height: INITIAL_CANVAS_HEIGHT,
            backgroundColor: 'transparent',
            selection: true,
        });

        fabricRef.current.freeDrawingBrush = new fabric.PencilBrush(fabricRef.current);
        fabricRef.current.freeDrawingBrush.width = currentWidth;
        fabricRef.current.freeDrawingBrush.color = currentColor;

        isInitialized.current = true;

        // Load initial state if available
        const currentFile = files.find(f => f.id === activeFileId);
        if (currentFile && currentFile.fabricJSON) {
            console.log('Loading initial canvas state for:', currentFile.name);
            // Wait a bit for canvas to be ready
            setTimeout(() => {
                if (fabricRef.current) {
                    fabricRef.current.loadFromJSON(currentFile.fabricJSON, () => {
                        fabricRef.current.renderAll();
                        // Save initial history
                        const json = fabricRef.current.toJSON(['globalCompositeOperation']);
                        setHistory([json]);
                        setHistoryIndex(0);
                    });
                }
            }, 100);
        } else {
            setTimeout(() => {
                const json = fabricRef.current.toJSON(['globalCompositeOperation']);
                setHistory([json]);
                setHistoryIndex(0);
            }, 100);
        }

        const handleResize = () => {
            if (fabricRef.current && containerRef.current) {
                const sidebarW = sidebarExpanded ? 200 : 64;
                const newWidth = containerRef.current.offsetWidth - sidebarW - 40;
                fabricRef.current.setDimensions({ width: newWidth });
            }
        };

        window.addEventListener('resize', handleResize);

        const handleContextMenu = (e) => {
            e.preventDefault();
            const rect = container.getBoundingClientRect();
            setToolbarPosition({
                x: e.clientX - rect.left,
                y: e.clientY - rect.top - 60,
            });
        };

        container?.addEventListener('contextmenu', handleContextMenu);

        return () => {
            window.removeEventListener('resize', handleResize);
            container?.removeEventListener('contextmenu', handleContextMenu);
            if (fabricRef.current) {
                fabricRef.current.dispose();
                fabricRef.current = null;
                isInitialized.current = false;
            }
        };
    }, []);

    // Keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
                e.preventDefault();
                e.shiftKey ? redo() : undo();
            }
            if ((e.metaKey || e.ctrlKey) && e.key === 'y') {
                e.preventDefault();
                redo();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [undo, redo]);

    // Left-click to dock toolbar
    useEffect(() => {
        if (!fabricRef.current) return;

        const canvas = fabricRef.current;

        const handleMouseDown = (e) => {
            if (toolbarPosition.x !== null && !e.target) {
                dockToolbar();
            }
        };

        canvas.on('mouse:down', handleMouseDown);
        return () => canvas.off('mouse:down', handleMouseDown);
    }, [toolbarPosition, dockToolbar]);

    // Infinite canvas extension & Socket Emitters
    useEffect(() => {
        if (!fabricRef.current) return;

        const canvas = fabricRef.current;

        const handleObjectModified = (e) => {
            extendCanvasIfNeeded(e.target);
            saveToHistory();

            // Broadcast modification
            if (roomId && !isRemoteUpdate.current && e.target) {
                // For paths, we might want to re-send the whole object or just the changes
                // Simple approach: send object modified event
                // Note: 'object:modified' fires after transform/move
                const objectId = e.target.id; // We need IDs for objects to sync modifications efficiently
                // If no ID (legacy/new), maybe send full sync or add-object?
                // For now, let's use the full sync for modifications to be safe, or just use add-object (upsert)
                const json = e.target.toJSON(['globalCompositeOperation']);

                // If it's a path created by drawing, it's handled by path:created usually, 
                // but checking logic: path:created fires for free drawing
                // object:modified fires for moving/scaling existing objects

                sendCanvasObjectModify(activeFileId, null, json);
            }
        };

        const handleObjectAdded = (e) => {
            extendCanvasIfNeeded(e.target);

            // Broadcast new object (if not remote)
            if (roomId && !isRemoteUpdate.current && e.target) {
                // If it's a path from free drawing, 'path:created' handles it. 
                // We should check if it's NOT a path from free drawing (e.g. shapes, text)
                // Fabric emits object:added for everything.
                // path:created is specific to PencilBrush.

                // We rely on path:created for free drawing to avoid duplicates if possible,
                // OR we just use object:added for everything and filter.
                // Let's use object:added for non-path objects (shapes, text)

                if (e.target.type !== 'path') {
                    const json = e.target.toJSON(['globalCompositeOperation']);
                    sendCanvasObjectAdd(activeFileId, json);
                }
            }
        };

        const handlePathCreated = (e) => {
            saveToHistory();
            if (roomId && !isRemoteUpdate.current && e.path) {
                const json = e.path.toJSON(['globalCompositeOperation']);
                sendCanvasPathCreate(activeFileId, json);
            }
        }

        canvas.on('object:modified', handleObjectModified);
        canvas.on('object:added', handleObjectAdded);
        canvas.on('path:created', handlePathCreated);

        return () => {
            canvas.off('object:modified', handleObjectModified);
            canvas.off('object:added', handleObjectAdded);
            canvas.off('path:created', handlePathCreated);
        };
    }, [extendCanvasIfNeeded, saveToHistory, roomId, activeFileId]);

    // Socket Listeners for Remote Updates
    useEffect(() => {
        if (!roomId || !fabricRef.current) return;

        const canvas = fabricRef.current;

        const handleRemotePathCreate = (data) => {
            if (data.canvasId !== activeFileId) return;
            console.log('remote path created');

            isRemoteUpdate.current = true;
            fabric.util.enlivenObjects([data.pathData], (objects) => {
                objects.forEach((obj) => {
                    canvas.add(obj);
                });
                canvas.renderAll();
                isRemoteUpdate.current = false;
                saveToHistory();
            });
        };

        const handleRemoteObjectAdd = (data) => {
            if (data.canvasId !== activeFileId) return;
            console.log('remote object added');

            isRemoteUpdate.current = true;
            fabric.util.enlivenObjects([data.object], (objects) => {
                objects.forEach((obj) => {
                    canvas.add(obj);
                });
                canvas.renderAll();
                isRemoteUpdate.current = false;
                saveToHistory();
            });
        };

        const handleRemoteObjectModify = (data) => {
            if (data.canvasId !== activeFileId) return;
            console.log('remote object modified');

            // Simple strategy: if we get a modify event, we could try to find the object by ID 
            // but strictly we are just sending the WHOLE object state in 'changes' (which is the object JSON)
            // So we can remove the old one (if we could ID it) or just re-add (might duplicate if not careful)
            // For a basic implementation, let's treat it like Add (Upsert) for now, 
            // OR implemented full sync if logic is complex.

            // Better: Use full sync for complex modifications to ensure consistency
            if (data.changes) {
                isRemoteUpdate.current = true;
                // Syncing individual objects without IDs is hard. 
                // Let's rely on Full Sync for major changes or assume 'changes' is the new object state
                fabric.util.enlivenObjects([data.changes], (objects) => {
                    objects.forEach((obj) => {
                        canvas.add(obj); // This duplicates if we don't remove old. 
                        // Real fix requires unique IDs on every object.
                    });
                    canvas.renderAll();
                    isRemoteUpdate.current = false;
                });
            }
        };

        const handleRemoteFullSync = (data) => {
            if (data.roomId !== roomId) return;
            // If active file ID matches or we want to overwrite
            // For now, only sync if it matches the active file (or main)
            if (data.canvasId && data.canvasId !== activeFileId && data.canvasId !== 'main') return;

            console.log('received full canvas sync');
            if (data.fabricJSON) {
                isRemoteUpdate.current = true;
                canvas.loadFromJSON(data.fabricJSON, () => {
                    canvas.renderAll();
                    isRemoteUpdate.current = false;
                    saveToHistory();
                });
            }
        };

        const unsubPathCreate = onCanvasPathCreate(handleRemotePathCreate);
        const unsubObjectAdd = onCanvasObjectAdd(handleRemoteObjectAdd);
        const unsubObjectModify = onCanvasObjectModify(handleRemoteObjectModify);
        const unsubFullSync = onCanvasFullSync(handleRemoteFullSync);

        return () => {
            unsubPathCreate();
            unsubObjectAdd();
            unsubObjectModify();
            unsubFullSync();
        };

    }, [roomId, activeFileId, saveToHistory]);

    // Text tool handler
    useEffect(() => {
        if (!fabricRef.current) return;

        const canvas = fabricRef.current;

        const handleMouseDown = (e) => {
            if (activeTool === TOOLS.TEXT && !e.target) {
                const pointer = canvas.getPointer(e.e);
                const textSettings = toolSettings[TOOLS.TEXT] || { color: '#000000', fontSize: 24 };
                const textColor = darkMode && isBlackColor(textSettings.color) ? '#ffffff' : textSettings.color;

                const text = new fabric.IText('Type here...', {
                    left: pointer.x,
                    top: pointer.y,
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                    fontSize: textSettings.fontSize || 24,
                    fill: textColor,
                    editable: true,
                });

                canvas.add(text);
                canvas.setActiveObject(text);
                text.enterEditing();
                text.selectAll();
                canvas.renderAll();

                saveToHistory();

                // Switch to select mode after adding text
                setActiveTool(TOOLS.SELECT);
            }
        };

        if (activeTool === TOOLS.TEXT) {
            canvas.on('mouse:down', handleMouseDown);
        }

        return () => {
            canvas.off('mouse:down', handleMouseDown);
        };
    }, [activeTool, darkMode, toolSettings, saveToHistory]);

    // Arrow tool handlers
    useEffect(() => {
        if (!fabricRef.current) return;

        const canvas = fabricRef.current;

        const handleMouseDown = (e) => {
            if (activeTool === TOOLS.ARROW && !e.target) {
                const pointer = canvas.getPointer(e.e);
                arrowStartPoint.current = { x: pointer.x, y: pointer.y };
                isDrawingArrow.current = true;

                tempArrowLine.current = new fabric.Line(
                    [pointer.x, pointer.y, pointer.x, pointer.y],
                    {
                        stroke: darkMode ? '#ffffff' : '#000000',
                        strokeWidth: 2,
                        strokeDashArray: [5, 5],
                        selectable: false,
                        evented: false,
                    }
                );
                canvas.add(tempArrowLine.current);
            }
        };

        const handleMouseMove = (e) => {
            if (isDrawingArrow.current && tempArrowLine.current) {
                const pointer = canvas.getPointer(e.e);
                tempArrowLine.current.set({ x2: pointer.x, y2: pointer.y });
                canvas.renderAll();
            }
        };

        const handleMouseUp = (e) => {
            if (isDrawingArrow.current && arrowStartPoint.current) {
                const pointer = canvas.getPointer(e.e);

                if (tempArrowLine.current) {
                    canvas.remove(tempArrowLine.current);
                    tempArrowLine.current = null;
                }

                const dx = pointer.x - arrowStartPoint.current.x;
                const dy = pointer.y - arrowStartPoint.current.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                if (distance > 20) {
                    const arrow = createSmartArrow(
                        arrowStartPoint.current.x,
                        arrowStartPoint.current.y,
                        pointer.x,
                        pointer.y
                    );
                    if (arrow) {
                        canvas.add(arrow);
                        canvas.setActiveObject(arrow);
                        saveToHistory();
                    }
                }

                arrowStartPoint.current = null;
                isDrawingArrow.current = false;
            }
        };

        if (activeTool === TOOLS.ARROW) {
            canvas.on('mouse:down', handleMouseDown);
            canvas.on('mouse:move', handleMouseMove);
            canvas.on('mouse:up', handleMouseUp);
        }

        return () => {
            canvas.off('mouse:down', handleMouseDown);
            canvas.off('mouse:move', handleMouseMove);
            canvas.off('mouse:up', handleMouseUp);
        };
    }, [activeTool, darkMode, createSmartArrow, saveToHistory]);

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
                canvas.freeDrawingBrush.width = settings.width || 5;
                canvas.freeDrawingBrush.color = settings.color || '#000000';
                canvas.freeDrawingBrush.globalCompositeOperation = 'source-over';
                break;

            case TOOLS.HIGHLIGHTER:
                canvas.isDrawingMode = true;
                canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
                canvas.freeDrawingBrush.width = settings.width || 30;
                canvas.freeDrawingBrush.color = (settings.color || '#FFCC00') + '80';
                canvas.freeDrawingBrush.globalCompositeOperation = 'source-over';
                break;

            case TOOLS.ERASER:
                canvas.isDrawingMode = true;
                canvas.freeDrawingBrush = new EraserBrush(canvas);
                canvas.freeDrawingBrush.width = settings.width || 20;
                break;

            case TOOLS.OBJECT_ERASER:
                canvas.isDrawingMode = false;
                canvas.selection = false;
                canvas.defaultCursor = 'crosshair';
                canvas.forEachObject(obj => { obj.selectable = true; });
                break;

            case TOOLS.ARROW:
                canvas.isDrawingMode = false;
                canvas.selection = false;
                canvas.defaultCursor = 'crosshair';
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

    // Object eraser handler
    useEffect(() => {
        if (!fabricRef.current) return;

        const canvas = fabricRef.current;

        const handleObjectClick = (e) => {
            if (activeTool === TOOLS.OBJECT_ERASER && e.target) {
                canvas.remove(e.target);
                canvas.renderAll();
                saveToHistory();
            }
        };

        canvas.on('mouse:down', handleObjectClick);
        return () => canvas.off('mouse:down', handleObjectClick);
    }, [activeTool, saveToHistory]);

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // REAL-TIME CANVAS SYNC - Sends full canvas JSON on any change
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    // Refs to prevent stale closures
    const activeFileIdRef = useRef(activeFileId);
    useEffect(() => {
        activeFileIdRef.current = activeFileId;
    }, [activeFileId]);

    // Ref for collaboration room ID (from props) - this is different from local file ID!
    const roomIdRef = useRef(roomId);
    useEffect(() => {
        roomIdRef.current = roomId;
    }, [roomId]);

    // ========================================
    // LOCAL STORAGE PERSISTENCE (Personal Canvas)
    // ========================================

    // Get or create a stable browser ID for this user
    const getBrowserId = useCallback(() => {
        const storageKey = 'codebuddy-browser-id';
        let browserId = localStorage.getItem(storageKey);
        if (!browserId) {
            // Generate a random ID and store it permanently
            browserId = 'user-' + Math.random().toString(36).substring(2, 15);
            localStorage.setItem(storageKey, browserId);
        }
        return browserId;
    }, []);

    // Generate a storage key unique to this room + browser (personal canvas)
    const getStorageKey = useCallback(() => {
        const browserId = getBrowserId();
        const key = `codebuddy-canvas-${roomId || 'local'}-${browserId}`;
        return key;
    }, [roomId, getBrowserId]);

    // Ref for save debounce timeout
    const saveTimeoutRef = useRef(null);

    // Save canvas to localStorage (debounced)
    const saveToLocalStorage = useCallback(() => {
        if (!fabricRef.current) return;

        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

        saveTimeoutRef.current = setTimeout(() => {
            const json = fabricRef.current.toJSON(['globalCompositeOperation']);
            const key = getStorageKey();
            try {
                localStorage.setItem(key, JSON.stringify(json));
                console.log('canvas saved to localStorage');
            } catch (e) {
                console.error('LocalStorage save error:', e.message);
            }
        }, 500); // Debounce by 500ms
    }, [getStorageKey]);

    // Load canvas from localStorage
    const loadFromLocalStorage = useCallback(() => {
        if (!fabricRef.current) return;

        const key = getStorageKey();
        try {
            const saved = localStorage.getItem(key);
            if (saved) {
                const json = JSON.parse(saved);
                fabricRef.current.loadFromJSON(json, () => {
                    fabricRef.current.renderAll();
                    console.log('canvas loaded from localStorage');
                });
            }
        } catch (e) {
            console.error('LocalStorage load error:', e.message);
        }
    }, [getStorageKey]);

    // Update refs for stable access
    const saveToHistoryRef = useRef(saveToHistory);
    useEffect(() => {
        saveToHistoryRef.current = saveToHistory;
    }, [saveToHistory]);

    // Debounced save handler for canvas events
    const debouncedSave = useCallback(() => {
        if (saveToHistoryRef.current) saveToHistoryRef.current();
        saveToLocalStorage();
    }, [saveToLocalStorage]);

    // Attach canvas event listeners for auto-save
    useEffect(() => {
        if (!fabricRef.current) return;
        const canvas = fabricRef.current;

        canvas.on('path:created', debouncedSave);
        canvas.on('object:added', debouncedSave);
        canvas.on('object:modified', debouncedSave);
        canvas.on('object:removed', debouncedSave);

        return () => {
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
            canvas.off('path:created', debouncedSave);
            canvas.off('object:added', debouncedSave);
            canvas.off('object:modified', debouncedSave);
            canvas.off('object:removed', debouncedSave);
        };
    }, [debouncedSave]);

    // Track if we've already loaded to prevent multiple loads
    const hasLoadedRef = useRef(false);

    // Load saved canvas on mount (after canvas is initialized)
    useEffect(() => {
        if (hasLoadedRef.current) return; // Only load once

        // Retry mechanism for loading (canvas might not be ready)
        let attempts = 0;
        const maxAttempts = 5;

        const tryLoad = () => {
            attempts++;
            if (fabricRef.current) {
                hasLoadedRef.current = true;
                loadFromLocalStorage();
            } else if (attempts < maxAttempts) {
                // Retry after 500ms
                setTimeout(tryLoad, 500);
            } else {
                console.log('canvas not ready for loading after max attempts');
            }
        };

        // Initial delay then try
        const loadTimer = setTimeout(tryLoad, 500);

        return () => clearTimeout(loadTimer);
    }, [loadFromLocalStorage]);

    // Socket connection status tracking
    const [socketConnected, setSocketConnected] = useState(isConnected());
    const [userCount, setUserCount] = useState(roomUsers?.length || 1);

    // Sync userCount with roomUsers prop from parent (App.jsx)
    useEffect(() => {
        if (roomUsers && roomUsers.length > 0) {
            console.log(`canvas user count: ${roomUsers.length}`);
            setUserCount(roomUsers.length);
        }
    }, [roomUsers]);

    useEffect(() => {
        const sock = getSocket();

        const handleConnect = () => {
            setSocketConnected(true);
            console.log('ðŸ”Œ Connected to collaboration server');
        };

        const handleDisconnect = () => {
            setSocketConnected(false);
            setUserCount(1);
            console.log('ðŸ”Œ Disconnected from collaboration server');
        };

        // Receive full user list when joining (from room-state event)
        const handleRoomState = (data) => {
            console.log(`room has ${data.users?.length || 0} users`);
            if (data.users) {
                setUserCount(data.users.length);
            }
        };

        // Receive user count updates (when someone joins/leaves)
        const handleUserCount = (data) => {
            console.log(`ðŸ‘¥ User count updated: ${data.count}`);
            setUserCount(data.count);
        };

        const handleUserJoined = (user) => {
            console.log(`ðŸ‘¤ ${user.userName} joined the room`);
        };

        const handleUserLeft = (user) => {
            console.log(`ðŸ‘¤ ${user.userName} left the room`);
        };

        sock.on('connect', handleConnect);
        sock.on('disconnect', handleDisconnect);
        sock.on('room-state', handleRoomState);
        sock.on('user-joined', handleUserJoined);
        sock.on('user-left', handleUserLeft);

        return () => {
            sock.off('connect', handleConnect);
            sock.off('disconnect', handleDisconnect);
            sock.off('room-state', handleRoomState);
            sock.off('user-joined', handleUserJoined);
            sock.off('user-left', handleUserLeft);
        };
    }, []);

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // FILE SYNC LISTENERS - Receive file create/rename/delete from other users
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    useEffect(() => {
        const sock = getSocket();

        // When another user creates a file
        const handleFileCreated = (data) => {
            console.log(`ðŸ“„ Remote file created: ${data.name}`);
            setFiles(prev => {
                // Avoid duplicates
                if (prev.some(f => f.id === data.id)) return prev;
                return [...prev, {
                    id: data.id,
                    name: data.name,
                    createdAt: data.createdAt,
                    data: null,
                }];
            });
        };

        // When another user renames a file
        const handleFileRenamed = (data) => {
            console.log(`ðŸ“ Remote file renamed: ${data.name}`);
            setFiles(prev => prev.map(f =>
                f.id === data.id ? { ...f, name: data.name } : f
            ));
        };

        // When another user deletes a file
        const handleFileDeleted = (data) => {
            console.log(`ðŸ—‘ï¸ Remote file deleted: ${data.id}`);
            setFiles(prev => prev.filter(f => f.id !== data.id));
        };

        sock.on('file-created', handleFileCreated);
        sock.on('file-renamed', handleFileRenamed);
        sock.on('file-deleted', handleFileDeleted);

        return () => {
            sock.off('file-created', handleFileCreated);
            sock.off('file-renamed', handleFileRenamed);
            sock.off('file-deleted', handleFileDeleted);
        };
    }, []);

    // Shape functions
    const addShape = (shapeType) => {
        if (!fabricRef.current) return;

        const canvas = fabricRef.current;
        const centerX = canvas.width / 2;
        const scrollTop = wrapperRef.current?.scrollTop || 0;
        const viewportCenter = scrollTop + (window.innerHeight - 140) / 2;
        const centerY = Math.min(viewportCenter, canvas.height - 100);
        const strokeColor = darkMode ? '#ffffff' : '#000000';

        let shape;

        switch (shapeType) {
            case 'square':
                shape = new fabric.Rect({
                    left: centerX - 50, top: centerY - 50,
                    width: 100, height: 100,
                    fill: 'transparent', stroke: strokeColor, strokeWidth: 2,
                });
                break;
            case 'rectangle':
                shape = new fabric.Rect({
                    left: centerX - 75, top: centerY - 40,
                    width: 150, height: 80,
                    fill: 'transparent', stroke: strokeColor, strokeWidth: 2,
                });
                break;
            case 'circle':
                shape = new fabric.Circle({
                    left: centerX - 50, top: centerY - 50, radius: 50,
                    fill: 'transparent', stroke: strokeColor, strokeWidth: 2,
                });
                break;
            case 'line':
                shape = new fabric.Line([centerX - 75, centerY, centerX + 75, centerY], {
                    stroke: strokeColor, strokeWidth: 2,
                });
                break;
            case 'arrow':
                shape = createSmartArrow(centerX - 75, centerY, centerX + 75, centerY);
                break;
            default:
                return;
        }

        if (shape) {
            canvas.add(shape);
            canvas.setActiveObject(shape);
            canvas.renderAll();
            // Note: Sync is handled automatically by object:added listener
            setActiveTool(TOOLS.SELECT);
            setShowShapesMenu(false);
        }
    };

    const clearCanvas = () => {
        if (!fabricRef.current) return;
        const canvas = fabricRef.current;
        canvas.clear();
        canvas.backgroundColor = 'transparent';
        canvas.renderAll();
        saveToHistory();

        // Sync clear to other users (with roomId for isolation)
        syncCanvas({
            type: 'clear',
            roomId: activeFileId,
            senderId: getSocketId(),
        });
    };

    const cycleBackground = () => {
        const modes = Object.values(BACKGROUND_MODES);
        const currentIndex = modes.indexOf(backgroundMode);
        setBackgroundMode(modes[(currentIndex + 1) % modes.length]);
    };

    const handleColorSelect = (color) => {
        if (activeTool === TOOLS.PEN) {
            updateToolSettings(TOOLS.PEN, { color });
        } else if (activeTool === TOOLS.HIGHLIGHTER) {
            updateToolSettings(TOOLS.HIGHLIGHTER, { color });
        } else if (activeTool === TOOLS.ARROW) {
            updateToolSettings(TOOLS.ARROW, { color });
        } else if (activeTool === TOOLS.TEXT) {
            updateToolSettings(TOOLS.TEXT, { color });
        }
        setShowColorPicker(false);
        if (activeTool === TOOLS.ERASER || activeTool === TOOLS.OBJECT_ERASER) {
            setActiveTool(TOOLS.PEN);
            updateToolSettings(TOOLS.PEN, { color });
        }
    };

    const handleSizeChange = (newSize) => {
        updateToolSettings(activeTool, { width: newSize });
    };

    // Styles
    const styles = {
        container: {
            position: 'relative',
            width: '100%',
            height: '100vh',
            backgroundColor: darkMode ? '#0d0d0d' : '#f5f5f7',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
        },
        header: {
            padding: '12px 20px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: darkMode ? '#1a1a1a' : '#ffffff',
            borderBottom: `1px solid ${darkMode ? '#333' : '#e0e0e0'}`,
            flexShrink: 0,
        },
        title: {
            margin: 0,
            fontSize: '18px',
            fontWeight: 600,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            color: darkMode ? '#ffffff' : '#1d1d1f',
        },
        mainContent: {
            flex: 1,
            display: 'flex',
            overflow: 'hidden',
        },
        sidebar: {
            width: sidebarExpanded ? '200px' : '64px',
            backgroundColor: darkMode ? '#141414' : '#f0f0f0',
            borderRight: `1px solid ${darkMode ? '#333' : '#e0e0e0'}`,
            display: 'flex',
            flexDirection: 'column',
            transition: 'width 0.2s ease',
            flexShrink: 0,
        },
        sidebarHeader: {
            padding: '12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: `1px solid ${darkMode ? '#333' : '#e0e0e0'}`,
        },
        sidebarTitle: {
            fontSize: '12px',
            fontWeight: 600,
            color: darkMode ? '#888' : '#666',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            display: sidebarExpanded ? 'block' : 'none',
        },
        addFileButton: {
            width: '28px',
            height: '28px',
            borderRadius: '6px',
            border: 'none',
            backgroundColor: '#007AFF',
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'transform 0.2s ease',
        },
        fileList: {
            flex: 1,
            overflow: 'auto',
            padding: '8px',
        },
        fileItem: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 12px',
            borderRadius: '8px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            marginBottom: '4px',
        },
        fileItemActive: {
            backgroundColor: darkMode ? '#2a2a2a' : '#ffffff',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        },
        fileItemInactive: {
            backgroundColor: 'transparent',
        },
        fileIcon: {
            flexShrink: 0,
            color: darkMode ? '#888' : '#666',
        },
        fileName: {
            fontSize: '13px',
            fontWeight: 500,
            color: darkMode ? '#fff' : '#333',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
        },
        fileTimestamp: {
            fontSize: '11px',
            color: darkMode ? '#666' : '#999',
            marginTop: '2px',
        },
        fileNameInput: {
            flex: 1,
            fontSize: '13px',
            fontWeight: 500,
            padding: '4px 8px',
            borderRadius: '4px',
            border: `1px solid #007AFF`,
            backgroundColor: darkMode ? '#1a1a1a' : '#fff',
            color: darkMode ? '#fff' : '#333',
            outline: 'none',
        },
        deleteFileButton: {
            width: '24px',
            height: '24px',
            borderRadius: '4px',
            border: 'none',
            backgroundColor: 'transparent',
            color: darkMode ? '#666' : '#999',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: 0,
            transition: 'opacity 0.2s ease',
        },
        canvasArea: {
            flex: 1,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
        },
        canvasWrapper: {
            flex: 1,
            overflow: 'auto',
            padding: '20px',
        },
        canvasContainer: {
            borderRadius: '12px',
            overflow: 'hidden',
            boxShadow: darkMode
                ? '0 4px 20px rgba(0,0,0,0.5)'
                : '0 4px 20px rgba(0,0,0,0.1)',
            display: 'inline-block',
            ...getBackgroundPattern(),
        },
        toolbar: {
            position: 'fixed',
            left: toolbarPosition.x ?? '50%',
            bottom: toolbarPosition.y ? 'auto' : '30px',
            top: toolbarPosition.y ?? 'auto',
            transform: toolbarPosition.x ? 'none' : 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '8px 12px',
            backgroundColor: darkMode ? 'rgba(40,40,40,0.95)' : 'rgba(255,255,255,0.95)',
            backdropFilter: 'blur(20px)',
            borderRadius: '50px',
            boxShadow: darkMode
                ? '0 8px 32px rgba(0,0,0,0.4)'
                : '0 8px 32px rgba(0,0,0,0.15)',
            zIndex: 1000,
        },
        toolButton: {
            width: '38px',
            height: '38px',
            borderRadius: '50%',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.2s ease',
            padding: 0,
        },
        activeButton: {
            backgroundColor: '#007AFF',
            color: '#ffffff',
            transform: 'scale(1.1)',
        },
        inactiveButton: {
            backgroundColor: darkMode ? '#3a3a3a' : '#f0f0f0',
            color: darkMode ? '#ffffff' : '#333333',
        },
        disabledButton: {
            backgroundColor: darkMode ? '#2a2a2a' : '#e0e0e0',
            color: darkMode ? '#555555' : '#999999',
            cursor: 'not-allowed',
            opacity: 0.5,
        },
        divider: {
            width: '1px',
            height: '28px',
            backgroundColor: darkMode ? '#444' : '#e0e0e0',
            margin: '0 4px',
        },
        colorSwatch: {
            width: '26px',
            height: '26px',
            borderRadius: '50%',
            border: '2px solid transparent',
            cursor: 'pointer',
            transition: 'transform 0.2s ease',
        },
        activeColor: {
            border: '2px solid #007AFF',
            transform: 'scale(1.15)',
            boxShadow: '0 2px 8px rgba(0,122,255,0.3)',
        },
        shapesMenu: {
            position: 'fixed',
            bottom: '90px',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            gap: '8px',
            padding: '12px 16px',
            backgroundColor: darkMode ? 'rgba(40,40,40,0.95)' : 'rgba(255,255,255,0.95)',
            backdropFilter: 'blur(20px)',
            borderRadius: '16px',
            boxShadow: darkMode
                ? '0 8px 32px rgba(0,0,0,0.4)'
                : '0 8px 32px rgba(0,0,0,0.15)',
            zIndex: 1001,
        },
        shapeButton: {
            padding: '10px 12px',
            borderRadius: '10px',
            border: 'none',
            backgroundColor: darkMode ? '#3a3a3a' : '#f0f0f0',
            color: darkMode ? '#ffffff' : '#333333',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 500,
            transition: 'all 0.2s ease',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
        },
        colorPickerPopup: {
            position: 'fixed',
            bottom: '90px',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '16px',
            backgroundColor: darkMode ? 'rgba(40,40,40,0.95)' : 'rgba(255,255,255,0.95)',
            backdropFilter: 'blur(20px)',
            borderRadius: '16px',
            boxShadow: darkMode
                ? '0 8px 32px rgba(0,0,0,0.4)'
                : '0 8px 32px rgba(0,0,0,0.15)',
            zIndex: 1001,
        },
        sizeSlider: {
            width: '70px',
            accentColor: '#007AFF',
        },
        headerControls: {
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
        },
        headerButton: {
            padding: '8px 12px',
            borderRadius: '8px',
            border: 'none',
            fontSize: '13px',
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            backgroundColor: darkMode ? '#3a3a3a' : '#f0f0f0',
            color: darkMode ? '#ffffff' : '#333333',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
        },
    };

    const getButtonStyle = (tool) => ({
        ...styles.toolButton,
        ...(activeTool === tool ? styles.activeButton : styles.inactiveButton),
    });

    const getColorStyle = (color) => {
        const isCurrentColor = currentColor === color;
        return {
            ...styles.colorSwatch,
            backgroundColor: color,
            ...(isCurrentColor ? styles.activeColor : {}),
            border: color === '#FFFFFF'
                ? `2px solid ${isCurrentColor ? '#007AFF' : '#ccc'}`
                : (isCurrentColor ? '2px solid #007AFF' : '2px solid transparent'),
        };
    };

    const isDrawingTool = [TOOLS.PEN, TOOLS.HIGHLIGHTER, TOOLS.ERASER].includes(activeTool);
    const showColors = [TOOLS.PEN, TOOLS.HIGHLIGHTER, TOOLS.ARROW, TOOLS.TEXT].includes(activeTool);
    const colorPalette = activeTool === TOOLS.HIGHLIGHTER ? HIGHLIGHTER_COLORS : PRESET_COLORS;

    const canUndo = historyIndex > 0;
    const canRedo = historyIndex < history.length - 1;

    return (
        <div style={styles.container} ref={containerRef}>
            {/* Header */}
            <div style={styles.header}>
                <h1 style={styles.title}>CodeBuddy Whiteboard</h1>
                <div style={styles.headerControls}>
                    <button
                        style={styles.headerButton}
                        onClick={cycleBackground}
                        title="Toggle Background: Plain / Ruled / Grid"
                    >
                        <Grid3X3 size={16} />
                        {backgroundMode.charAt(0).toUpperCase() + backgroundMode.slice(1)}
                    </button>
                    <button
                        style={{
                            ...styles.headerButton,
                            backgroundColor: darkMode ? '#007AFF' : '#f0f0f0',
                            color: darkMode ? '#fff' : '#333',
                        }}
                        onClick={toggleDarkMode}
                        title={darkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                    >
                        {darkMode ? <Sun size={16} /> : <Moon size={16} />}
                        {darkMode ? 'Light' : 'Dark'}
                    </button>
                    <button
                        style={{
                            ...styles.headerButton,
                            backgroundColor: isExporting ? '#999' : '#34C759',
                            color: '#fff',
                            cursor: isExporting ? 'wait' : 'pointer',
                        }}
                        onClick={exportToPDF}
                        disabled={isExporting}
                        title="Download canvas as PDF"
                    >
                        <Download size={16} />
                        {isExporting ? 'Exporting...' : 'PDF'}
                    </button>

                    {/* Connection Status Indicator */}
                    <div
                        style={{
                            ...styles.headerButton,
                            backgroundColor: socketConnected ? '#34C759' : '#FF3B30',
                            color: '#fff',
                            cursor: 'default',
                            gap: '6px',
                        }}
                        title={socketConnected ? 'Connected to collaboration server' : 'Disconnected - trying to reconnect...'}
                    >
                        {socketConnected ? <Wifi size={16} /> : <WifiOff size={16} />}
                        {socketConnected ? 'Online' : 'Offline'}
                        {socketConnected && userCount > 0 && (
                            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '4px' }}>
                                <Users size={14} />
                                {userCount}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* Main Content - Sidebar + Canvas */}
            <div style={styles.mainContent}>
                {/* Sidebar */}
                <div style={styles.sidebar}>
                    <div style={styles.sidebarHeader}>
                        <span style={styles.sidebarTitle}>Files</span>
                        <button
                            style={styles.addFileButton}
                            onClick={createFile}
                            title="Create new canvas"
                        >
                            <FilePlus size={16} />
                        </button>
                    </div>
                    <div style={styles.fileList}>
                        {files.map((file) => (
                            <div
                                key={file.id}
                                style={{
                                    ...styles.fileItem,
                                    ...(file.id === activeFileId ? styles.fileItemActive : styles.fileItemInactive),
                                }}
                                onClick={() => switchToFile(file.id)}
                                onDoubleClick={() => startRenaming(file.id, file.name)}
                                onMouseEnter={(e) => {
                                    const deleteBtn = e.currentTarget.querySelector('.delete-btn');
                                    if (deleteBtn) deleteBtn.style.opacity = '1';
                                }}
                                onMouseLeave={(e) => {
                                    const deleteBtn = e.currentTarget.querySelector('.delete-btn');
                                    if (deleteBtn) deleteBtn.style.opacity = '0';
                                }}
                            >
                                <FileText size={18} style={styles.fileIcon} />
                                {editingFileId === file.id ? (
                                    <input
                                        type="text"
                                        value={editingFileName}
                                        onChange={(e) => setEditingFileName(e.target.value)}
                                        onBlur={finishRenaming}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') finishRenaming();
                                            if (e.key === 'Escape') cancelRenaming();
                                        }}
                                        style={styles.fileNameInput}
                                        autoFocus
                                        onClick={(e) => e.stopPropagation()}
                                    />
                                ) : (
                                    <div style={{ flex: 1, overflow: 'hidden', display: sidebarExpanded ? 'block' : 'none' }}>
                                        <span style={styles.fileName}>{file.name}</span>
                                        <div style={styles.fileTimestamp}>
                                            {new Date(file.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </div>
                                    </div>
                                )}
                                {files.length > 1 && sidebarExpanded && (
                                    <button
                                        className="delete-btn"
                                        style={styles.deleteFileButton}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            deleteFile(file.id);
                                        }}
                                        title="Delete file"
                                    >
                                        <X size={14} />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Canvas Area */}
                <div style={styles.canvasArea}>
                    <div style={styles.canvasWrapper} ref={wrapperRef}>
                        <div id="canvas-stage" style={styles.canvasContainer}>
                            <canvas ref={canvasRef} />
                        </div>
                    </div>
                </div>
            </div>

            {/* Floating Toolbar */}
            <div style={styles.toolbar}>
                <button
                    style={{
                        ...styles.toolButton,
                        ...(canUndo ? styles.inactiveButton : styles.disabledButton),
                    }}
                    onClick={undo}
                    disabled={!canUndo}
                    title="Undo (Ctrl+Z)"
                >
                    <Undo2 size={18} />
                </button>

                <button
                    style={{
                        ...styles.toolButton,
                        ...(canRedo ? styles.inactiveButton : styles.disabledButton),
                    }}
                    onClick={redo}
                    disabled={!canRedo}
                    title="Redo (Ctrl+Shift+Z / Ctrl+Y)"
                >
                    <Redo2 size={18} />
                </button>

                <div style={styles.divider} />

                <button
                    style={getButtonStyle(TOOLS.SELECT)}
                    onClick={() => setActiveTool(TOOLS.SELECT)}
                    title="Select Tool (V)"
                >
                    <MousePointer2 size={18} />
                </button>

                <div style={styles.divider} />

                <button
                    style={getButtonStyle(TOOLS.PEN)}
                    onClick={() => setActiveTool(TOOLS.PEN)}
                    title="Pen Tool (P)"
                >
                    <Pencil size={18} />
                </button>

                <button
                    style={getButtonStyle(TOOLS.HIGHLIGHTER)}
                    onClick={() => setActiveTool(TOOLS.HIGHLIGHTER)}
                    title="Highlighter Tool (H)"
                >
                    <Highlighter size={18} />
                </button>

                <button
                    style={getButtonStyle(TOOLS.TEXT)}
                    onClick={() => setActiveTool(TOOLS.TEXT)}
                    title="Text Tool (T) - Click to add editable text"
                >
                    <Type size={18} />
                </button>

                <button
                    style={getButtonStyle(TOOLS.ARROW)}
                    onClick={() => setActiveTool(TOOLS.ARROW)}
                    title="Arrow Tool (A)"
                >
                    <ArrowRight size={18} />
                </button>

                <button
                    style={getButtonStyle(TOOLS.ERASER)}
                    onClick={() => setActiveTool(TOOLS.ERASER)}
                    title="Pixel Eraser (E)"
                >
                    <Eraser size={18} />
                </button>

                <button
                    style={getButtonStyle(TOOLS.OBJECT_ERASER)}
                    onClick={() => setActiveTool(TOOLS.OBJECT_ERASER)}
                    title="Object Eraser (D)"
                >
                    <Trash2 size={18} />
                </button>

                <div style={styles.divider} />

                {isDrawingTool && (
                    <>
                        <input
                            type="range"
                            min="1"
                            max="50"
                            value={currentWidth}
                            onChange={(e) => handleSizeChange(parseInt(e.target.value))}
                            style={styles.sizeSlider}
                            title={`Brush Size: ${currentWidth}px`}
                        />
                        <div style={styles.divider} />
                    </>
                )}

                {showColors && (
                    <>
                        {colorPalette.map((color) => (
                            <div
                                key={color.name}
                                style={getColorStyle(color.hex)}
                                onClick={() => handleColorSelect(color.hex)}
                                title={`Color: ${color.name}`}
                            />
                        ))}

                        <div
                            style={{
                                ...styles.colorSwatch,
                                background: customColor !== '#007AFF' && currentColor === customColor
                                    ? customColor
                                    : 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)',
                                ...(showColorPicker ? styles.activeColor : {}),
                            }}
                            onClick={() => setShowColorPicker(!showColorPicker)}
                            title="Custom Color Picker"
                        />
                        <div style={styles.divider} />
                    </>
                )}

                <button
                    style={{
                        ...styles.toolButton,
                        ...(showShapesMenu ? styles.activeButton : styles.inactiveButton),
                    }}
                    onClick={() => setShowShapesMenu(!showShapesMenu)}
                    title="Add Shape (+)"
                >
                    <Plus size={20} />
                </button>

                <button
                    style={{
                        ...styles.toolButton,
                        ...styles.inactiveButton,
                    }}
                    onClick={clearCanvas}
                    title="Clear Canvas"
                >
                    <Trash2 size={18} />
                </button>
            </div>

            {showShapesMenu && (
                <div style={styles.shapesMenu}>
                    <button style={styles.shapeButton} onClick={() => addShape('square')} title="Add Square">
                        <Square size={16} /> Square
                    </button>
                    <button style={styles.shapeButton} onClick={() => addShape('rectangle')} title="Add Rectangle">
                        <RectangleHorizontal size={16} /> Rectangle
                    </button>
                    <button style={styles.shapeButton} onClick={() => addShape('circle')} title="Add Circle">
                        <Circle size={16} /> Circle
                    </button>
                    <button style={styles.shapeButton} onClick={() => addShape('line')} title="Add Line">
                        <Minus size={16} /> Line
                    </button>
                    <button style={styles.shapeButton} onClick={() => addShape('arrow')} title="Add Arrow">
                        <ArrowRight size={16} /> Arrow
                    </button>
                </div>
            )}

            {showColorPicker && (
                <div style={styles.colorPickerPopup}>
                    <input
                        type="color"
                        value={customColor}
                        onChange={(e) => setCustomColor(e.target.value)}
                        style={{ width: '100%', height: '40px', border: 'none', cursor: 'pointer' }}
                        title="Pick a custom color"
                    />
                    <button
                        style={{
                            ...styles.shapeButton,
                            width: '100%',
                            marginTop: '10px',
                            backgroundColor: '#007AFF',
                            color: '#fff',
                            justifyContent: 'center',
                        }}
                        onClick={() => handleColorSelect(customColor)}
                        title="Apply selected color"
                    >
                        <Palette size={16} /> Apply Color
                    </button>
                </div>
            )}
        </div>
    );
};

export default Canvas;
