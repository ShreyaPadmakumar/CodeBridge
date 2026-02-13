import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import Editor from '@monaco-editor/react';
import {
    Play,
    Settings,
    Code2,
    ChevronDown,
    Sun,
    Moon,
    Loader2,
    FileCode,
    History
} from 'lucide-react';
import TabBar from './TabBar';
import NewFileModal from './NewFileModal';
import DownloadButton from './DownloadButton';
import SnapshotPanel from './SnapshotPanel';
import intentDetector, { INTENTS } from '../../services/intentDetector';
import { createSnapshot } from '../../services/snapshotService';
import { sendIntentUpdate } from '../../services/socket';
import {
    sendCodeChange,
    onCodeChange as onRemoteCodeChange,
    sendFileCreate,
    sendFileDelete,
    onFileCreate as onRemoteFileCreate,
    onFileDelete as onRemoteFileDelete,
    isConnected,
    emitCursorPosition,
    onCursorPosition,
    offCursorPosition,
    getSocketId,
    requestCursors
} from '../../services/socket';

// Storage keys
const STORAGE_KEYS = {
    TABS: 'codebuddy_tabs',
    ACTIVE_TAB: 'codebuddy_activeTab',
    SETTINGS: 'codebuddy_settings',
    TAB_GROUPS: 'codebuddy_tabGroups'
};

// Default settings
const DEFAULT_SETTINGS = {
    fontSize: 14,
    theme: 'vs-dark',
    autocomplete: true,
    wordWrap: true
};

// Language configurations
const LANGUAGES = {
    python: { id: 'python', name: 'Python', extension: '.py' },
    javascript: { id: 'javascript', name: 'JavaScript', extension: '.js' },
    cpp: { id: 'cpp', name: 'C++', extension: '.cpp' },
    java: { id: 'java', name: 'Java', extension: '.java' },
    c: { id: 'c', name: 'C', extension: '.c' }
};

// C++ headers for autocomplete (cached)
const CPP_HEADERS = ['iostream', 'vector', 'string', 'algorithm', 'map', 'set', 'queue', 'stack', 'deque', 'list', 'unordered_map', 'unordered_set', 'cmath', 'cstdio', 'cstdlib', 'cstring', 'fstream', 'sstream', 'iomanip', 'climits', 'cassert', 'bitset', 'numeric', 'functional', 'iterator', 'memory', 'utility', 'tuple', 'array'];

const C_HEADERS = ['stdio.h', 'stdlib.h', 'string.h', 'math.h', 'ctype.h', 'time.h', 'stdbool.h', 'stdint.h', 'limits.h', 'float.h', 'errno.h', 'assert.h'];

const PYTHON_MODULES = ['os', 'sys', 'json', 'math', 'random', 're', 'datetime', 'time', 'collections', 'itertools', 'functools', 'operator', 'string', 'io', 'pathlib'];

// Toggle Switch Component (memoized)
const ToggleSwitch = memo(function ToggleSwitch({ enabled, onChange, label }) {
    return (
        <div className="flex items-center gap-3">
            <span className="text-sm text-[#7a7a80]">{label}:</span>
            <button
                onClick={() => onChange(!enabled)}
                className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${enabled ? 'bg-[#6e7bf2]' : 'bg-[#222225]'}`}
            >
                <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
            <span className="text-xs text-[#4e4e56]">{enabled ? 'ON' : 'OFF'}</span>
        </div>
    );
});

// Debounce utility (outside component to avoid recreation)
function createDebouncedFunction(fn, delay) {
    let timeoutId = null;
    return (...args) => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delay);
    };
}

// Generate unique ID
const generateId = () => Date.now() + Math.random().toString(36).substr(2, 9);

// Default tab
const createDefaultTab = () => ({
    id: generateId(),
    filename: 'main.py',
    language: 'python',
    code: '',
    groupId: null
});

// Load from localStorage with validation
const loadFromStorage = () => {
    try {
        const savedTabs = localStorage.getItem(STORAGE_KEYS.TABS);
        const savedActiveTab = localStorage.getItem(STORAGE_KEYS.ACTIVE_TAB);
        const savedSettings = localStorage.getItem(STORAGE_KEYS.SETTINGS);
        const savedTabGroups = localStorage.getItem(STORAGE_KEYS.TAB_GROUPS);

        let tabs = null;
        let activeTabId = null;
        let settings = DEFAULT_SETTINGS;
        let tabGroups = [];

        if (savedTabs) {
            const parsed = JSON.parse(savedTabs);
            if (Array.isArray(parsed) && parsed.length > 0) {
                tabs = parsed.map(t => ({ ...t, groupId: t.groupId || null }));
                activeTabId = savedActiveTab || parsed[0].id;
            }
        }

        if (savedSettings) {
            settings = { ...DEFAULT_SETTINGS, ...JSON.parse(savedSettings) };
        }

        if (savedTabGroups) {
            const parsedGroups = JSON.parse(savedTabGroups);
            if (Array.isArray(parsedGroups)) {
                tabGroups = parsedGroups;
            }
        }

        if (!tabs) {
            const defaultTab = createDefaultTab();
            tabs = [defaultTab];
            activeTabId = defaultTab.id;
        }

        // Validate groups
        const validGroupIds = new Set(tabGroups.map(g => g.id));
        tabs = tabs.map(tab => {
            if (tab.groupId && !validGroupIds.has(tab.groupId)) {
                return { ...tab, groupId: null };
            }
            return tab;
        });

        const usedGroupIds = new Set(tabs.filter(t => t.groupId).map(t => t.groupId));
        tabGroups = tabGroups.filter(group => usedGroupIds.has(group.id));

        return { tabs, activeTabId, settings, tabGroups };
    } catch (e) {
        console.error('Error loading from storage:', e);
        const defaultTab = createDefaultTab();
        return { tabs: [defaultTab], activeTabId: defaultTab.id, settings: DEFAULT_SETTINGS, tabGroups: [] };
    }
};

// Memoized Editor wrapper for performance
const MemoizedEditor = memo(Editor, (prevProps, nextProps) => {
    return (
        prevProps.language === nextProps.language &&
        prevProps.theme === nextProps.theme &&
        prevProps.height === nextProps.height
        // Don't compare options or value - let Monaco handle internally
    );
});

export default function CodeEditor({
    roomId = '',
    onCodeChange = () => { },
    onExecute = () => { },
    isExecuting = false,
    initialRoomState = null  // Room state for late joiners
}) {
    // Track if code change is from remote (prevent echo)
    const isRemoteChangeRef = useRef(false);
    const localStorageState = loadFromStorage();

    // Tab state - use room state if available (late joiner), otherwise localStorage
    const [tabs, setTabs] = useState(() => {
        if (initialRoomState?.codeFiles?.length > 0) {
            return initialRoomState.codeFiles.map(f => ({
                id: f.id,
                filename: f.filename,
                language: f.language,
                code: f.content || '',
                groupId: f.groupId || null
            }));
        }
        return localStorageState.tabs;
    });
    const [activeTabId, setActiveTabId] = useState(() => {
        if (initialRoomState?.activeCodeFileId) {
            return initialRoomState.activeCodeFileId;
        }
        return localStorageState.activeTabId;
    });
    const [tabGroups, setTabGroups] = useState(() => {
        if (initialRoomState?.tabGroups) {
            return initialRoomState.tabGroups;
        }
        return localStorageState.tabGroups;
    });
    const [showNewFileModal, setShowNewFileModal] = useState(false);

    // Settings state
    const [fontSize, setFontSize] = useState(localStorageState.settings.fontSize);
    const [theme, setTheme] = useState(localStorageState.settings.theme);
    const [autocomplete, setAutocomplete] = useState(localStorageState.settings.autocomplete);
    const [wordWrap, setWordWrap] = useState(localStorageState.settings.wordWrap);
    const [showSettings, setShowSettings] = useState(false);

    // Editor state
    const [isEditorReady, setIsEditorReady] = useState(false);
    const [showLanguageDropdown, setShowLanguageDropdown] = useState(false);

    // Intent-Aware Collaboration state
    const [currentIntent, setCurrentIntent] = useState(null);
    const [showSnapshotPanel, setShowSnapshotPanel] = useState(false);
    const snapshotTimerRef = useRef(null);

    // PERFORMANCE: Use refs for frequently changing values
    const editorRef = useRef(null);
    const monacoRef = useRef(null);
    const dropdownRef = useRef(null);
    const containerRef = useRef(null);
    const codeRef = useRef(''); // Store current code without causing re-renders
    const activeTabIdRef = useRef(activeTabId);
    const tabsRef = useRef(tabs);
    const roomIdRef = useRef(roomId); // Ref for roomId to avoid stale closures
    const completionProvidersRef = useRef([]);

    // Remote cursors from other users
    const remoteCursorsRef = useRef(new Map()); // Map<socketId, {username, color, position, decorationIds}>
    const cursorDecorationsRef = useRef([]); // Current decoration IDs

    // Keep refs in sync with state
    useEffect(() => {
        activeTabIdRef.current = activeTabId;
        tabsRef.current = tabs;
        roomIdRef.current = roomId;
        console.log('refs synced:', { activeTabId, tabsCount: tabs.length, roomId });
    }, [activeTabId, tabs, roomId]);

    // Load room state when it arrives (for late joiners)
    const hasLoadedRoomState = useRef(false);
    useEffect(() => {
        if (initialRoomState?.codeFiles?.length > 0 && !hasLoadedRoomState.current) {
            console.log('loading room state into CodeEditor:', initialRoomState.codeFiles.length, 'files');
            hasLoadedRoomState.current = true;

            const newTabs = initialRoomState.codeFiles.map(f => ({
                id: f.id,
                filename: f.filename,
                language: f.language,
                code: f.content || '',
                groupId: f.groupId || null
            }));
            setTabs(newTabs);

            // Determine which tab to activate
            const activeId = initialRoomState.activeCodeFileId || (newTabs.length > 0 ? newTabs[0].id : null);
            if (activeId) {
                setActiveTabId(activeId);

                // Also update codeRef and Monaco editor with the active tab's content
                const activeFile = newTabs.find(t => t.id === activeId);
                if (activeFile) {
                    codeRef.current = activeFile.code;
                    // Update Monaco editor if it's ready
                    if (editorRef.current) {
                        const currentValue = editorRef.current.getValue();
                        if (currentValue !== activeFile.code) {
                            console.log('updating editor with loaded content');
                            editorRef.current.setValue(activeFile.code);
                        }
                    }
                }
            }

            if (initialRoomState.tabGroups) {
                setTabGroups(initialRoomState.tabGroups);
            }
        }
    }, [initialRoomState]);

    // Get active tab (memoized)
    const activeTab = useMemo(() =>
        tabs.find(t => t.id === activeTabId) || tabs[0],
        [tabs, activeTabId]
    );

    const language = activeTab?.language || 'python';
    const currentLang = LANGUAGES[language];

    // PERFORMANCE: Debounced localStorage save (2 seconds)
    const saveToStorageRef = useRef(createDebouncedFunction(() => {
        try {
            // Update the current tab's code before saving
            const currentTabs = tabsRef.current.map(tab =>
                tab.id === activeTabIdRef.current
                    ? { ...tab, code: codeRef.current }
                    : tab
            );
            localStorage.setItem(STORAGE_KEYS.TABS, JSON.stringify(currentTabs));
            localStorage.setItem(STORAGE_KEYS.ACTIVE_TAB, activeTabIdRef.current);
        } catch (e) {
            console.error('Error saving to storage:', e);
        }
    }, 2000));

    // PERFORMANCE: Debounced tab code update (1 second)
    const updateTabCodeRef = useRef(createDebouncedFunction((newCode) => {
        setTabs(prev => prev.map(tab =>
            tab.id === activeTabIdRef.current ? { ...tab, code: newCode } : tab
        ));
    }, 1000));

    // PERFORMANCE: Debounced code change notification (500ms)
    const notifyCodeChangeRef = useRef(createDebouncedFunction((newCode, lang) => {
        const currentRoomId = roomIdRef.current;
        const currentActiveTabId = activeTabIdRef.current;
        const currentTabs = tabsRef.current;

        console.log('notifyCodeChange:', {
            currentRoomId,
            connected: isConnected(),
            isRemote: isRemoteChangeRef.current,
            currentActiveTabId,
            tabsCount: currentTabs?.length,
            tabIds: currentTabs?.map(t => t.id)
        });

        onCodeChange(newCode, lang);

        // Send to socket for real-time sync (only if not from remote)
        if (currentRoomId && isConnected() && !isRemoteChangeRef.current) {
            // Try to find the active tab, fallback to first tab
            let currentTab = currentTabs?.find(t => t.id === currentActiveTabId);
            if (!currentTab && currentTabs?.length > 0) {
                currentTab = currentTabs[0];
                console.log('fallback tab:', currentTab.id);
            }

            if (currentTab) {
                console.log('sending code change for tab:', currentTab.id, currentTab.filename);
                sendCodeChange(currentTab.id, newCode, null);
            } else {
                console.warn('no tabs available!');
            }
        }
        isRemoteChangeRef.current = false;
    }, 300));

    // Save settings to localStorage (debounced)
    useEffect(() => {
        const saveSettings = createDebouncedFunction(() => {
            localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify({ fontSize, theme, autocomplete, wordWrap }));
        }, 1000);
        saveSettings();
    }, [fontSize, theme, autocomplete, wordWrap]);

    // Save tab groups to localStorage (debounced)
    useEffect(() => {
        const saveGroups = createDebouncedFunction(() => {
            localStorage.setItem(STORAGE_KEYS.TAB_GROUPS, JSON.stringify(tabGroups));
        }, 500);
        saveGroups();
    }, [tabGroups]);

    // Socket event listeners for real-time sync
    useEffect(() => {
        if (!roomId) {
            console.log('no roomId, skipping socket listeners');
            return;
        }

        console.log('setting up socket listeners for room:', roomId);

        // Listen for remote code changes
        const unsubCodeChange = onRemoteCodeChange((data) => {
            console.log('remote code change:', {
                fileId: data.fileId,
                contentLength: data.content?.length,
                from: data.username
            });

            // Find the tab that matches the file ID, or use the first tab as fallback
            let tab = tabsRef.current.find(t => t.id === data.fileId);

            // If no matching tab found, update the first/current tab
            if (!tab && tabsRef.current.length > 0) {
                tab = tabsRef.current[0];
                console.log('fallback tab for receive:', tab.id);
            }

            if (tab) {
                console.log('updating tab with remote content:', tab.id);

                // Update tab content
                setTabs(prev => prev.map(t =>
                    t.id === tab.id ? { ...t, code: data.content } : t
                ));

                // If this is the active tab (or we're using fallback), update the editor
                if (editorRef.current) {
                    const currentValue = editorRef.current.getValue();
                    if (currentValue !== data.content) {
                        isRemoteChangeRef.current = true;
                        // Save cursor position
                        const position = editorRef.current.getPosition();
                        editorRef.current.setValue(data.content);
                        // Restore cursor position
                        if (position) {
                            editorRef.current.setPosition(position);
                        }
                    }
                }
            }
        });

        // Listen for remote file creation
        const unsubFileCreate = onRemoteFileCreate((data) => {
            if (data.file) {
                const newTab = {
                    id: data.file.id,
                    filename: data.file.filename,
                    language: data.file.language,
                    code: data.file.content || '',
                    groupId: data.file.groupId || null
                };
                setTabs(prev => [...prev, newTab]);
            }
        });

        // Listen for remote file deletion
        const unsubFileDelete = onRemoteFileDelete((data) => {
            setTabs(prev => {
                if (prev.length <= 1) return prev;
                const newTabs = prev.filter(t => t.id !== data.fileId);
                if (data.fileId === activeTabIdRef.current && newTabs.length > 0) {
                    setActiveTabId(newTabs[0].id);
                }
                return newTabs;
            });
        });

        return () => {
            unsubCodeChange();
            unsubFileCreate();
            unsubFileDelete();
        };
    }, [roomId]);

    // Listen for remote cursor positions and render decorations
    useEffect(() => {
        if (!roomId) return;

        const handleCursorPosition = ({ socketId, username, color, position }) => {
            // Validate incoming data
            if (!socketId || !position) return;

            const mySocketId = getSocketId();
            if (socketId === mySocketId) return; // Ignore own cursor

            // Sanitize socketId for CSS class names
            const safeId = String(socketId).replace(/[^a-zA-Z0-9]/g, '');

            // Only show cursors for the same file
            if (position.fileId !== activeTabIdRef.current) {
                // User is in a different file, remove their cursor
                remoteCursorsRef.current.delete(socketId);
            } else {
                // Update cursor position
                remoteCursorsRef.current.set(socketId, { username: username || 'User', color: color || '#FF6B6B', position, safeId });
            }

            // Re-render all decorations
            if (editorRef.current && monacoRef.current) {
                const editor = editorRef.current;
                const monaco = monacoRef.current;

                const newDecorations = [];
                remoteCursorsRef.current.forEach((cursor, id) => {
                    if (!cursor || !cursor.position || !id) return; // Skip invalid entries

                    const { username: name, color: cursorColor, position: pos, safeId: cssId } = cursor;
                    const safeCssId = cssId || String(id || '').replace(/[^a-zA-Z0-9]/g, '');
                    if (!safeCssId) return; // Skip if no valid ID

                    // Cursor line decoration (colored background)
                    newDecorations.push({
                        range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column + 1),
                        options: {
                            className: `remote-cursor-${safeCssId}`,
                            beforeContentClassName: `remote-cursor-marker`,
                            hoverMessage: { value: name },
                            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
                        }
                    });

                    // Inject dynamic CSS for this cursor's color
                    const styleId = `cursor-style-${safeCssId}`;
                    if (!document.getElementById(styleId)) {
                        const style = document.createElement('style');
                        style.id = styleId;
                        style.textContent = `
                            .remote-cursor-${safeCssId}::before {
                                content: '';
                                position: absolute;
                                width: 2px;
                                height: 18px;
                                background: ${cursorColor};
                                animation: cursor-blink 1s ease-in-out infinite;
                            }
                            .remote-cursor-${safeCssId}::after {
                                content: '${name}';
                                position: absolute;
                                top: -18px;
                                left: 0;
                                background: ${cursorColor};
                                color: white;
                                font-size: 10px;
                                padding: 1px 4px;
                                border-radius: 2px;
                                white-space: nowrap;
                                z-index: 1000;
                            }
                        `;
                        document.head.appendChild(style);
                    }
                });

                // Update decorations
                cursorDecorationsRef.current = editor.deltaDecorations(
                    cursorDecorationsRef.current,
                    newDecorations
                );
            }
        };

        // Remove stale cursors after 5 seconds of inactivity
        const cleanupInterval = setInterval(() => {
            // This is a simple implementation - could be enhanced with timestamps
        }, 5000);

        onCursorPosition(handleCursorPosition);

        // Request existing cursor positions (for late joiners)
        setTimeout(() => requestCursors(), 1000);

        return () => {
            offCursorPosition(handleCursorPosition);
            clearInterval(cleanupInterval);
            // Clean up dynamic styles
            remoteCursorsRef.current.forEach((cursor, id) => {
                const safeCssId = cursor?.safeId || String(id || '').replace(/[^a-zA-Z0-9]/g, '');
                if (!safeCssId) return;
                const styleId = `cursor-style-${safeCssId}`;
                const style = document.getElementById(styleId);
                if (style) style.remove();
            });
        };
    }, [roomId]);

    // Close dropdown on outside click
    useEffect(() => {
        function handleClickOutside(event) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
                setShowLanguageDropdown(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Cache for autocomplete suggestions
    const suggestionCacheRef = useRef(new Map());

    // Register completion providers (optimized)
    const registerCompletionProviders = useCallback((monaco) => {
        completionProvidersRef.current.forEach(p => p.dispose());
        completionProvidersRef.current = [];

        if (!autocomplete) return;

        const cache = suggestionCacheRef.current;

        // C++ Provider (optimized with caching)
        const cppProvider = monaco.languages.registerCompletionItemProvider('cpp', {
            triggerCharacters: ['<', '#', '.'],
            provideCompletionItems: (model, position) => {
                const lineContent = model.getLineContent(position.lineNumber);
                const textUntilPosition = lineContent.substring(0, position.column - 1);

                // Early return for empty/short input
                const word = model.getWordUntilPosition(position);
                if (word.word.length < 1 && !textUntilPosition.includes('#') && !textUntilPosition.includes('<')) {
                    return { suggestions: [] };
                }

                // Check for #include<partial pattern
                const includeMatch = textUntilPosition.match(/#include\s*<(\w*)$/);
                if (includeMatch) {
                    const typedPart = includeMatch[1].toLowerCase();
                    const cacheKey = `cpp-include-${typedPart}`;

                    if (cache.has(cacheKey)) {
                        return { suggestions: cache.get(cacheKey) };
                    }

                    const matchStart = position.column - includeMatch[1].length - 1;
                    const suggestions = CPP_HEADERS
                        .filter(h => h.toLowerCase().startsWith(typedPart))
                        .slice(0, 10) // Limit results
                        .map(header => ({
                            label: header,
                            kind: monaco.languages.CompletionItemKind.File,
                            insertText: header + '>',
                            range: {
                                startLineNumber: position.lineNumber,
                                endLineNumber: position.lineNumber,
                                startColumn: matchStart + 1,
                                endColumn: position.column
                            },
                            detail: `#include <${header}>`
                        }));

                    cache.set(cacheKey, suggestions);
                    return { suggestions };
                }

                // Standard word completion
                const range = {
                    startLineNumber: position.lineNumber,
                    endLineNumber: position.lineNumber,
                    startColumn: word.startColumn,
                    endColumn: word.endColumn
                };

                const prefix = word.word.toLowerCase();
                const cacheKey = `cpp-word-${prefix}`;

                if (cache.has(cacheKey)) {
                    return { suggestions: cache.get(cacheKey) };
                }

                const snippets = [
                    { label: 'for', insertText: 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t${3}\n}', detail: 'For Loop' },
                    { label: 'while', insertText: 'while (${1:condition}) {\n\t${2}\n}', detail: 'While Loop' },
                    { label: 'if', insertText: 'if (${1:condition}) {\n\t${2}\n}', detail: 'If Statement' },
                    { label: 'cout', insertText: 'std::cout << ${1:value} << std::endl;', detail: 'Output' },
                    { label: 'cin', insertText: 'std::cin >> ${1:variable};', detail: 'Input' },
                    { label: 'main', insertText: '#include <iostream>\nusing namespace std;\n\nint main() {\n\t${1}\n\treturn 0;\n}', detail: 'Main' },
                ];

                const suggestions = snippets
                    .filter(s => s.label.startsWith(prefix))
                    .map(s => ({
                        label: s.label,
                        kind: monaco.languages.CompletionItemKind.Snippet,
                        insertText: s.insertText,
                        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                        detail: s.detail,
                        range
                    }));

                cache.set(cacheKey, suggestions);
                return { suggestions };
            }
        });

        // C Provider (simplified)
        const cProvider = monaco.languages.registerCompletionItemProvider('c', {
            triggerCharacters: ['<', '#'],
            provideCompletionItems: (model, position) => {
                const lineContent = model.getLineContent(position.lineNumber);
                const textUntilPosition = lineContent.substring(0, position.column - 1);

                const includeMatch = textUntilPosition.match(/#include\s*<(\w*)$/);
                if (includeMatch) {
                    const typedPart = includeMatch[1].toLowerCase();
                    const matchStart = position.column - includeMatch[1].length - 1;

                    return {
                        suggestions: C_HEADERS
                            .filter(h => h.toLowerCase().startsWith(typedPart))
                            .slice(0, 10)
                            .map(header => ({
                                label: header,
                                kind: monaco.languages.CompletionItemKind.File,
                                insertText: header + '>',
                                range: {
                                    startLineNumber: position.lineNumber,
                                    endLineNumber: position.lineNumber,
                                    startColumn: matchStart + 1,
                                    endColumn: position.column
                                },
                                detail: `#include <${header}>`
                            }))
                    };
                }

                return { suggestions: [] };
            }
        });

        // Python Provider (simplified)
        const pythonProvider = monaco.languages.registerCompletionItemProvider('python', {
            triggerCharacters: [' '],
            provideCompletionItems: (model, position) => {
                const lineContent = model.getLineContent(position.lineNumber);
                const textUntilPosition = lineContent.substring(0, position.column - 1);

                const importMatch = textUntilPosition.match(/^(?:import|from)\s+(\w*)$/);
                if (importMatch) {
                    const typedPart = importMatch[1].toLowerCase();
                    const matchStart = position.column - importMatch[1].length;

                    return {
                        suggestions: PYTHON_MODULES
                            .filter(m => m.startsWith(typedPart))
                            .slice(0, 10)
                            .map(mod => ({
                                label: mod,
                                kind: monaco.languages.CompletionItemKind.Module,
                                insertText: mod,
                                range: {
                                    startLineNumber: position.lineNumber,
                                    endLineNumber: position.lineNumber,
                                    startColumn: matchStart,
                                    endColumn: position.column
                                },
                                detail: `import ${mod}`
                            }))
                    };
                }

                const word = model.getWordUntilPosition(position);
                const prefix = word.word.toLowerCase();

                if (prefix.length < 2) return { suggestions: [] };

                const snippets = [
                    { label: 'for', insertText: 'for ${1:i} in range(${2:n}):\n\t${3:pass}', detail: 'For Loop' },
                    { label: 'def', insertText: 'def ${1:function_name}(${2:args}):\n\t${3:pass}', detail: 'Function' },
                    { label: 'class', insertText: 'class ${1:ClassName}:\n\tdef __init__(self):\n\t\t${2:pass}', detail: 'Class' },
                    { label: 'print', insertText: 'print(${1:value})', detail: 'Print' },
                    { label: 'if', insertText: 'if ${1:condition}:\n\t${2:pass}', detail: 'If' },
                ];

                return {
                    suggestions: snippets
                        .filter(s => s.label.startsWith(prefix))
                        .map(s => ({
                            label: s.label,
                            kind: monaco.languages.CompletionItemKind.Snippet,
                            insertText: s.insertText,
                            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                            detail: s.detail,
                            range: {
                                startLineNumber: position.lineNumber,
                                endLineNumber: position.lineNumber,
                                startColumn: word.startColumn,
                                endColumn: word.endColumn
                            }
                        }))
                };
            }
        });

        // JavaScript Provider (simplified)
        const jsProvider = monaco.languages.registerCompletionItemProvider('javascript', {
            provideCompletionItems: (model, position) => {
                const word = model.getWordUntilPosition(position);
                const prefix = word.word.toLowerCase();

                if (prefix.length < 2) return { suggestions: [] };

                const snippets = [
                    { label: 'for', insertText: 'for (let ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t${3}\n}', detail: 'For' },
                    { label: 'function', insertText: 'function ${1:name}(${2:params}) {\n\t${3}\n}', detail: 'Function' },
                    { label: 'log', insertText: 'console.log(${1:value});', detail: 'Log' },
                    { label: 'const', insertText: 'const ${1:name} = ${2:value};', detail: 'Const' },
                ];

                return {
                    suggestions: snippets
                        .filter(s => s.label.startsWith(prefix))
                        .map(s => ({
                            label: s.label,
                            kind: monaco.languages.CompletionItemKind.Snippet,
                            insertText: s.insertText,
                            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                            detail: s.detail,
                            range: {
                                startLineNumber: position.lineNumber,
                                endLineNumber: position.lineNumber,
                                startColumn: word.startColumn,
                                endColumn: word.endColumn
                            }
                        }))
                };
            }
        });

        completionProvidersRef.current = [cppProvider, cProvider, pythonProvider, jsProvider];
    }, [autocomplete]);

    // Update tab language
    const updateTabLanguage = useCallback((newLanguage) => {
        const ext = LANGUAGES[newLanguage].extension;
        setTabs(prevTabs => prevTabs.map(tab => {
            if (tab.id === activeTabId) {
                const baseName = tab.filename.split('.')[0];
                return { ...tab, language: newLanguage, filename: baseName + ext };
            }
            return tab;
        }));
        setShowLanguageDropdown(false);
    }, [activeTabId]);

    // Update a specific tab property
    const updateTab = useCallback((tabId, updates) => {
        setTabs(prevTabs => prevTabs.map(tab =>
            tab.id === tabId ? { ...tab, ...updates } : tab
        ));
    }, []);

    // Tab handlers
    const handleTabClick = useCallback((tabId) => {
        // Save current code before switching
        if (editorRef.current && activeTabIdRef.current !== tabId) {
            const currentCode = editorRef.current.getValue();
            setTabs(prev => prev.map(tab =>
                tab.id === activeTabIdRef.current ? { ...tab, code: currentCode } : tab
            ));
        }
        setActiveTabId(tabId);
    }, []);

    const handleTabClose = useCallback((tabId) => {
        setTabs(prev => {
            if (prev.length <= 1) return prev;
            const newTabs = prev.filter(t => t.id !== tabId);
            if (tabId === activeTabIdRef.current) {
                setActiveTabId(newTabs[0].id);
            }
            return newTabs;
        });

        // Sync file deletion to other users
        if (roomIdRef.current && isConnected()) {
            console.log('syncing file deletion:', tabId);
            sendFileDelete(tabId);
        }
    }, []);

    const handleCloseOtherTabs = useCallback((tabId) => {
        setTabs(prev => prev.filter(t => t.id === tabId));
        setActiveTabId(tabId);
    }, []);

    const handleNewTab = useCallback((filename, lang) => {
        // Save current code before creating new tab
        if (editorRef.current) {
            const currentCode = editorRef.current.getValue();
            setTabs(prev => prev.map(tab =>
                tab.id === activeTabIdRef.current ? { ...tab, code: currentCode } : tab
            ));
        }

        const newTab = { id: generateId(), filename, language: lang, code: '', groupId: null };
        setTabs(prev => [...prev, newTab]);
        setActiveTabId(newTab.id);

        // Sync file creation to other users
        if (roomIdRef.current && isConnected()) {
            console.log('syncing new file:', newTab.filename);
            sendFileCreate({
                id: newTab.id,
                filename: newTab.filename,
                language: newTab.language,
                content: newTab.code,
                groupId: newTab.groupId
            });
        }
    }, []);

    // Handle tabs reorder (from drag and drop)
    const handleTabsReorder = useCallback((newTabs) => {
        setTabs(newTabs);
    }, []);

    // Execute function
    const executeCode = useCallback(() => {
        if (!isExecuting && editorRef.current) {
            const code = editorRef.current.getValue();
            onExecute(code, language);
        }
    }, [isExecuting, language, onExecute]);

    // Global keyboard shortcut handler
    useEffect(() => {
        const handleKeyDown = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                executeCode();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
                e.preventDefault();
                setShowNewFileModal(true);
            }
        };

        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [executeCode]);

    // PERFORMANCE: Editor mount handler with optimized event listeners
    const handleEditorMount = useCallback((editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;

        // Set initial code
        const tab = tabsRef.current.find(t => t.id === activeTabIdRef.current);
        if (tab) {
            codeRef.current = tab.code || '';
        }

        // Register autocomplete
        registerCompletionProviders(monaco);

        // PERFORMANCE: Listen to changes directly on editor instance
        editor.onDidChangeModelContent((e) => {
            const value = editor.getValue();
            codeRef.current = value;

            // Debounced side effects - no state updates on every keystroke!
            saveToStorageRef.current();
            updateTabCodeRef.current(value);
            notifyCodeChangeRef.current(value, language);

            // Feed changes to Intent Detector
            e.changes.forEach(change => {
                intentDetector.recordChange({
                    text: change.text,
                    rangeLength: change.rangeLength,
                });
            });
        });

        // Feed cursor moves to Intent Detector
        editor.onDidChangeCursorPosition(() => {
            intentDetector.recordCursorMove();
        });

        // Keyboard shortcut
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, executeCode);

        // Emit cursor position to other users (debounced)
        let cursorTimeout = null;
        editor.onDidChangeCursorPosition((e) => {
            if (cursorTimeout) clearTimeout(cursorTimeout);
            cursorTimeout = setTimeout(() => {
                emitCursorPosition({
                    lineNumber: e.position.lineNumber,
                    column: e.position.column,
                    fileId: activeTabIdRef.current
                });
            }, 50); // Debounce by 50ms
        });

        editor.focus();
        setIsEditorReady(true);

        // Start Intent Detector
        intentDetector.start((newIntent) => {
            setCurrentIntent(newIntent);
            sendIntentUpdate(newIntent);

            // Auto-snapshot: start timer when entering Experimenting mode
            if (newIntent.key === 'experimenting') {
                if (!snapshotTimerRef.current) {
                    snapshotTimerRef.current = setInterval(() => {
                        const code = codeRef.current;
                        const tab = tabsRef.current.find(t => t.id === activeTabIdRef.current);
                        if (code && tab) {
                            createSnapshot(code, tab.filename, tab.language);
                        }
                    }, 30000); // Auto-snapshot every 30s while experimenting
                }
            } else {
                // Clear snapshot timer when leaving Experimenting mode
                if (snapshotTimerRef.current) {
                    clearInterval(snapshotTimerRef.current);
                    snapshotTimerRef.current = null;
                }
            }
        });

        return () => {
            intentDetector.stop();
            if (snapshotTimerRef.current) {
                clearInterval(snapshotTimerRef.current);
                snapshotTimerRef.current = null;
            }
        };
    }, [language, registerCompletionProviders, executeCode]);

    // Update editor content when switching tabs
    useEffect(() => {
        if (editorRef.current && isEditorReady && activeTab) {
            const currentValue = editorRef.current.getValue();
            const newValue = activeTab.code || '';

            // Only update if content is different (prevents cursor jump)
            if (currentValue !== newValue) {
                editorRef.current.setValue(newValue);
                codeRef.current = newValue;
            }
        }
    }, [activeTabId, isEditorReady]); // Only depend on activeTabId, not activeTab

    // Re-register completion providers when autocomplete setting changes
    useEffect(() => {
        if (monacoRef.current && isEditorReady) {
            registerCompletionProviders(monacoRef.current);
        }
    }, [autocomplete, isEditorReady, registerCompletionProviders]);

    // PERFORMANCE: Memoized editor options
    const editorOptions = useMemo(() => ({
        fontFamily: "'JetBrains Mono', 'Consolas', monospace",
        fontSize: fontSize,
        lineNumbers: 'on',
        minimap: { enabled: false },
        wordWrap: wordWrap ? 'on' : 'off',
        bracketPairColorization: { enabled: true },

        // PERFORMANCE: Disable smooth animations
        smoothScrolling: false,
        cursorBlinking: 'solid',
        cursorSmoothCaretAnimation: 'off',

        padding: { top: 16, bottom: 16 },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 4,
        insertSpaces: true,
        renderLineHighlight: 'line', // Not 'all'
        contextmenu: true,
        folding: true,
        foldingHighlight: false,
        showFoldingControls: 'mouseover',

        // PERFORMANCE: Optimize suggestions
        quickSuggestions: autocomplete ? { other: true, comments: false, strings: false } : false,
        suggestOnTriggerCharacters: autocomplete,
        acceptSuggestionOnEnter: autocomplete ? 'smart' : 'off',
        tabCompletion: autocomplete ? 'on' : 'off',
        wordBasedSuggestions: 'off', // Disable expensive word-based suggestions
        snippetSuggestions: autocomplete ? 'top' : 'none',
        parameterHints: { enabled: autocomplete },

        // PERFORMANCE: Disable expensive rendering
        renderWhitespace: 'none',
        renderControlCharacters: false,
        hover: { enabled: true, delay: 500 },

        autoClosingBrackets: 'always',
        autoClosingQuotes: 'always',
        autoSurround: 'languageDefined',
        formatOnType: false, // Disable for performance
        formatOnPaste: false, // Disable for performance
        suggest: autocomplete ? {
            showKeywords: true,
            showSnippets: true,
            showClasses: true,
            showFunctions: true,
            showVariables: false, // Disable for performance
            showWords: false, // Disable for performance
            insertMode: 'replace',
            filterGraceful: true,
            localityBonus: true,
            shareSuggestSelections: false
        } : { showKeywords: false, showSnippets: false }
    }), [fontSize, wordWrap, autocomplete]);

    // Get code for download (from editor if available)
    const getCode = useCallback(() => {
        if (editorRef.current) {
            return editorRef.current.getValue();
        }
        return activeTab?.code || '';
    }, [activeTab?.code]);

    return (
        <div ref={containerRef} className="flex flex-col h-full bg-[#141416] rounded-xl overflow-hidden border border-[#222225]" tabIndex={0}>
            {/* Toolbar */}
            <div className="flex items-center justify-between px-4 py-2 bg-[#141416] border-b border-[#222225]">
                <div className="flex items-center gap-3">
                    <div className="relative" ref={dropdownRef}>
                        <button
                            onClick={() => setShowLanguageDropdown(!showLanguageDropdown)}
                            className="flex items-center gap-2 px-3 py-1.5 bg-[#222225] hover:bg-[#2a2a30] rounded-lg transition-colors"
                        >
                            <Code2 className="w-4 h-4 text-[#6e7bf2]" />
                            <span className="text-sm text-[#ededef]">{currentLang?.name}</span>
                            <ChevronDown className={`w-4 h-4 text-[#7a7a80] transition-transform ${showLanguageDropdown ? 'rotate-180' : ''}`} />
                        </button>

                        {showLanguageDropdown && (
                            <div className="absolute top-full left-0 mt-1 w-40 bg-[#1a1a1e] border border-[#222225] rounded-lg shadow-xl z-50 overflow-hidden animate-fadeIn">
                                {Object.entries(LANGUAGES).map(([id, lang]) => (
                                    <button
                                        key={id}
                                        onClick={() => updateTabLanguage(id)}
                                        className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors
                      ${language === id ? 'bg-[#6e7bf2]/20 text-[#6e7bf2]' : 'text-[#ededef] hover:bg-[#222225]'}`}
                                    >
                                        <FileCode className="w-4 h-4" />
                                        {lang.name}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-2 px-3 py-1.5 bg-[#141416] rounded-lg">
                        <FileCode className="w-4 h-4 text-[#7a7a80]" />
                        <span className="text-sm text-[#7a7a80]">{activeTab?.filename}</span>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {/* Intent Badge - shows current user's intent */}
                    {currentIntent && (
                        <div className="intent-self-badge" style={{ '--intent-color': currentIntent.color }}>
                            <span>{currentIntent.emoji}</span>
                            <span className="text-xs">{currentIntent.label}</span>
                        </div>
                    )}

                    <DownloadButton code={getCode()} filename={activeTab?.filename} language={language} />

                    {/* Snapshot Button */}
                    <button
                        onClick={() => setShowSnapshotPanel(!showSnapshotPanel)}
                        className={`p-2 rounded-lg transition-colors ${showSnapshotPanel ? 'bg-[#f0a641]/20 text-[#f0a641]' : 'hover:bg-[#222225] text-[#7a7a80]'}`}
                        title="Code Snapshots"
                    >
                        <History className="w-4 h-4" />
                    </button>

                    <button
                        onClick={() => setShowSettings(!showSettings)}
                        className={`p-2 rounded-lg transition-colors ${showSettings ? 'bg-[#6e7bf2]/20 text-[#6e7bf2]' : 'hover:bg-[#222225] text-[#7a7a80]'}`}
                        title="Settings"
                    >
                        <Settings className="w-4 h-4" />
                    </button>

                    <button
                        onClick={executeCode}
                        disabled={isExecuting}
                        className={`flex items-center gap-2 px-4 py-1.5 rounded-lg font-medium text-sm transition-all
              ${isExecuting ? 'bg-[#22c55e]/50 cursor-not-allowed' : 'bg-[#22c55e] hover:bg-[#16a34a] hover:shadow-lg hover:shadow-[#22c55e]/20'} text-white`}
                    >
                        {isExecuting ? (
                            <><Loader2 className="w-4 h-4 animate-spin" /><span>Running...</span></>
                        ) : (
                            <><Play className="w-4 h-4" /><span>Run</span></>
                        )}
                    </button>
                </div>
            </div>

            {/* Settings Panel */}
            {showSettings && (
                <div className="px-4 py-3 bg-[#1a1a1e] border-b border-[#222225] animate-fadeIn">
                    <div className="flex flex-wrap items-center gap-6">
                        <div className="flex items-center gap-3">
                            <span className="text-sm text-[#7a7a80]">Theme:</span>
                            <button
                                onClick={() => setTheme(theme === 'vs-dark' ? 'light' : 'vs-dark')}
                                className="flex items-center gap-2 px-3 py-1.5 bg-[#222225] hover:bg-[#2a2a30] rounded-lg transition-colors"
                            >
                                {theme === 'vs-dark' ? (
                                    <><Moon className="w-4 h-4 text-[#6e7bf2]" /><span className="text-sm text-[#ededef]">Dark</span></>
                                ) : (
                                    <><Sun className="w-4 h-4 text-[#f0a641]" /><span className="text-sm text-[#ededef]">Light</span></>
                                )}
                            </button>
                        </div>

                        <div className="flex items-center gap-3">
                            <span className="text-sm text-[#7a7a80]">Font:</span>
                            <input type="range" min="10" max="24" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))}
                                className="w-20 h-2 bg-[#222225] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-[#6e7bf2] [&::-webkit-slider-thumb]:rounded-full" />
                            <span className="text-sm text-[#ededef] w-8">{fontSize}px</span>
                        </div>

                        <ToggleSwitch enabled={autocomplete} onChange={setAutocomplete} label="Autocomplete" />
                        <ToggleSwitch enabled={wordWrap} onChange={setWordWrap} label="Word Wrap" />
                    </div>
                </div>
            )}

            {/* Tab Bar with Groups */}
            <TabBar
                tabs={tabs}
                activeTabId={activeTabId}
                tabGroups={tabGroups}
                onTabClick={handleTabClick}
                onTabClose={handleTabClose}
                onCloseOtherTabs={handleCloseOtherTabs}
                onNewTab={() => setShowNewFileModal(true)}
                onTabGroupsChange={setTabGroups}
                onTabUpdate={updateTab}
                onTabsReorder={handleTabsReorder}
            />

            {/* Experimenting Mode Banner */}
            {currentIntent?.key === 'experimenting' && (
                <div className="experimenting-banner">
                    <span>🧪</span>
                    <span>Experimenting — auto-saving snapshots</span>
                </div>
            )}

            {/* Monaco Editor */}
            <div className="flex-1 relative">
                {!isEditorReady && (
                    <div className="absolute inset-0 flex items-center justify-center bg-[#141416] z-10">
                        <div className="flex flex-col items-center gap-3">
                            <Loader2 className="w-8 h-8 text-[#6e7bf2] animate-spin" />
                            <span className="text-sm text-[#7a7a80]">Loading editor...</span>
                        </div>
                    </div>
                )}

                {/* PERFORMANCE: Using uncontrolled mode with defaultValue */}
                <MemoizedEditor
                    height="100%"
                    language={language}
                    theme={theme}
                    defaultValue={activeTab?.code || ''}
                    onMount={handleEditorMount}
                    options={editorOptions}
                    loading={null}
                />

                {/* Snapshot Panel (slides over editor) */}
                <SnapshotPanel
                    isOpen={showSnapshotPanel}
                    onClose={() => setShowSnapshotPanel(false)}
                    onRestore={(code, filename) => {
                        if (editorRef.current) {
                            isRemoteChangeRef.current = true;
                            editorRef.current.setValue(code);
                            codeRef.current = code;
                            isRemoteChangeRef.current = false;
                        }
                    }}
                    isExperimenting={currentIntent?.key === 'experimenting'}
                />
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-4 py-2 bg-[#141416] border-t border-[#222225]">
                <div className="flex items-center gap-4">
                    <span className="text-xs text-[#4e4e56]">{roomId ? `Room: ${roomId}` : 'Local'}</span>
                    <span className="text-xs text-[#4e4e56]">{tabs.length} file{tabs.length !== 1 ? 's' : ''}</span>
                    {tabGroups.length > 0 && <span className="text-xs text-[#4e4e56]">{tabGroups.length} group{tabGroups.length !== 1 ? 's' : ''}</span>}
                </div>
                <div className="flex items-center gap-1 text-xs text-[#4e4e56]">
                    <kbd className="px-1.5 py-0.5 bg-[#222225] rounded text-[#7a7a80]">Ctrl</kbd>
                    <span>+</span>
                    <kbd className="px-1.5 py-0.5 bg-[#222225] rounded text-[#7a7a80]">Enter</kbd>
                    <span className="ml-1">to run</span>
                </div>
            </div>

            {/* New File Modal */}
            <NewFileModal
                isOpen={showNewFileModal}
                onClose={() => setShowNewFileModal(false)}
                onCreate={handleNewTab}
                existingFilenames={tabs.map(t => t.filename.toLowerCase())}
            />
        </div>
    );
}
