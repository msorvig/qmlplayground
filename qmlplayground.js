// QmlPlayground - Self-contained QML playground component with Shadow DOM

import { QmlRuntime } from './qmlruntime.js';

// Load CodeMirror dynamically
async function loadCodeMirror() {
    if (typeof CodeMirror !== 'undefined') return;

    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'codemirror.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// Register QML mode for CodeMirror
function registerQmlMode() {
    if (CodeMirror.modes.qml) return;

    CodeMirror.defineMode("qml", function(config) {
        const keywords = [
            "import", "as", "on", "property", "alias", "signal", "readonly",
            "default", "required", "component"
        ];
        const jsKeywords = [
            "var", "let", "const", "function", "return", "if", "else", "for",
            "while", "do", "switch", "case", "break", "continue", "try",
            "catch", "finally", "throw", "new", "typeof", "instanceof", "in",
            "true", "false", "null", "undefined", "this"
        ];
        const types = [
            "int", "real", "double", "string", "bool", "var", "url", "color",
            "date", "point", "size", "rect", "list", "variant"
        ];
        const qmlTypes = [
            "Item", "Rectangle", "Text", "Image", "MouseArea", "Column", "Row",
            "Grid", "Flow", "ListView", "GridView", "Repeater", "Loader",
            "Component", "Timer", "Animation", "PropertyAnimation",
            "NumberAnimation", "ColorAnimation", "RotationAnimation",
            "SequentialAnimation", "ParallelAnimation", "Behavior",
            "State", "Transition", "Canvas", "Window", "ApplicationWindow"
        ];

        function tokenBase(stream, state) {
            const ch = stream.peek();
            if (ch === "/") {
                stream.next();
                if (stream.eat("/")) { stream.skipToEnd(); return "comment"; }
                if (stream.eat("*")) { state.tokenize = tokenComment; return tokenComment(stream, state); }
                stream.backUp(1);
            }
            if (ch === '"' || ch === "'") {
                stream.next();
                state.tokenize = tokenString(ch);
                return state.tokenize(stream, state);
            }
            if (/\d/.test(ch)) {
                stream.match(/^\d*\.?\d*([eE][+-]?\d+)?/);
                return "number";
            }
            if (/[\w_]/.test(ch)) {
                stream.match(/^[\w_]+/);
                const word = stream.current();
                if (keywords.includes(word)) return "keyword";
                if (jsKeywords.includes(word)) return "keyword";
                if (types.includes(word)) return "type";
                if (qmlTypes.includes(word)) return "type";
                if (/^[A-Z]/.test(word)) return "type";
                if (stream.peek() === ':') return "property";
                return "variable";
            }
            if (/[+\-*/%=<>!&|^~?:]/.test(ch)) { stream.next(); return "operator"; }
            if (/[{}\[\]()]/.test(ch)) { stream.next(); return "bracket"; }
            stream.next();
            return null;
        }

        function tokenString(quote) {
            return function(stream, state) {
                let escaped = false, ch;
                while ((ch = stream.next()) != null) {
                    if (ch === quote && !escaped) { state.tokenize = tokenBase; break; }
                    escaped = !escaped && ch === "\\";
                }
                return "string";
            };
        }

        function tokenComment(stream, state) {
            let ch;
            while ((ch = stream.next()) != null) {
                if (ch === "*" && stream.eat("/")) { state.tokenize = tokenBase; break; }
            }
            return "comment";
        }

        return {
            startState: () => ({ tokenize: tokenBase }),
            token: (stream, state) => stream.eatSpace() ? null : state.tokenize(stream, state),
            lineComment: "//",
            blockCommentStart: "/*",
            blockCommentEnd: "*/"
        };
    });
    CodeMirror.defineMIME("text/x-qml", "qml");
}

class QmlPlayground extends EventTarget {
    static getBuildMode() {
        return localStorage.getItem('qmlplayground-build-mode') || 'static';
    }

    constructor(container) {
        super();
        this.container = container || document.body;
        this.shadow = this.container.attachShadow({ mode: 'open' });
        this.buildMode = QmlPlayground.getBuildMode();

        // Options
        this.examplesUrl = 'examples/index.json';
        this.autoRun = true;
        this.autoRunDelay = 500;

        // Internal state
        this.runtime = null;
        this.editor = null;
        this._autoRunTimeout = null;
        this._suppressAutoRun = false;
        this._errorMarkers = [];
        this._examples = [];

        this._buildDOM();
    }

    _buildDOM() {
        // Inject CodeMirror stylesheets into shadow DOM
        const cmStyle = document.createElement('link');
        cmStyle.rel = 'stylesheet';
        cmStyle.href = 'codemirror.min.css';
        this.shadow.appendChild(cmStyle);

        const cmTheme = document.createElement('link');
        cmTheme.rel = 'stylesheet';
        cmTheme.href = 'gruvbox-dark.min.css';
        this.shadow.appendChild(cmTheme);

        // Inject styles
        const style = document.createElement('style');
        style.textContent = `
            :host {
                display: flex;
                flex-direction: column;
                width: 100%;
                height: 100%;
                --bg-primary: #1e1e1e;
                --bg-secondary: #252526;
                --bg-tertiary: #2d2d30;
                --text-primary: #d4d4d4;
                --text-secondary: #808080;
                --accent: #0e639c;
                --accent-hover: #1177bb;
                --border: #3c3c3c;
                --error: #f14c4c;
                --warning: #cca700;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: var(--bg-primary);
                color: var(--text-primary);
            }

            * {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
            }

            .toolbar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                height: 40px;
                flex-shrink: 0;
                padding: 0 12px;
                background: var(--bg-secondary);
                border-bottom: 1px solid var(--border);
            }

            .toolbar-left, .toolbar-right {
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .toolbar-title {
                font-size: 14px;
                font-weight: 500;
            }

            .toolbar button {
                padding: 6px 12px;
                background: var(--accent);
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
            }

            .toolbar button:hover {
                background: var(--accent-hover);
            }

            .auto-run-label {
                display: flex;
                align-items: center;
                gap: 4px;
                font-size: 13px;
                color: var(--text-secondary);
                cursor: pointer;
            }

            .main-container {
                display: flex;
                flex: 1;
                min-height: 0;
            }

            .editor-pane {
                flex: 1;
                min-width: 200px;
                display: flex;
                flex-direction: column;
                border-right: 1px solid var(--border);
            }

            .preview-pane {
                flex: 1;
                min-width: 200px;
                position: relative;
                background: var(--bg-tertiary);
                overflow: hidden;
            }

            .examples-dropdown {
                position: absolute;
                top: 40px;
                right: 12px;
                background: var(--bg-secondary);
                border: 1px solid var(--border);
                border-radius: 4px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                z-index: 100;
                min-width: 160px;
            }

            .examples-dropdown.hidden {
                display: none;
            }

            .examples-dropdown button {
                display: block;
                width: 100%;
                padding: 10px 16px;
                background: none;
                border: none;
                color: var(--text-primary);
                text-align: left;
                cursor: pointer;
                font-size: 13px;
            }

            .examples-dropdown button:hover {
                background: var(--accent);
            }

            .resizer {
                width: 4px;
                background: var(--border);
                cursor: col-resize;
            }

            .resizer:hover {
                background: var(--accent);
            }

            .qt-container {
                width: 100%;
                height: 100%;
                background: var(--bg-tertiary);
            }

            .qt-container::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: var(--bg-tertiary);
                z-index: 10;
                pointer-events: none;
            }

            .qt-container.qt-ready::before {
                display: none;
            }

            .loading {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                text-align: center;
                color: var(--text-secondary);
                z-index: 20;
            }

            .loading.hidden {
                display: none;
            }

            .spinner {
                width: 40px;
                height: 40px;
                margin: 0 auto 12px;
                border: 3px solid var(--border);
                border-top-color: var(--accent);
                border-radius: 50%;
                animation: spin 1s linear infinite;
            }

            @keyframes spin {
                to { transform: rotate(360deg); }
            }

            .console-pane {
                height: 36px;
                flex-shrink: 0;
                background: var(--bg-secondary);
                border-top: 1px solid var(--border);
                overflow: hidden;
                transition: height 0.2s ease;
            }

            .console-pane.expanded {
                height: 180px;
            }

            .console-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                height: 36px;
                padding: 0 12px;
                cursor: pointer;
                font-size: 13px;
            }

            .console-header button {
                background: none;
                border: none;
                color: var(--text-secondary);
                cursor: pointer;
                padding: 4px;
            }

            .console-content {
                height: calc(100% - 36px);
                overflow-y: auto;
                padding: 8px 12px;
                font-family: 'Fira Code', monospace;
                font-size: 12px;
            }

            .status-text {
                font-weight: 500;
            }

            .status-loading, .status-running {
                color: var(--accent);
            }

            .status-ready {
                color: #4ec9b0;
            }

            .status-error {
                color: var(--error);
            }

            .status-warning {
                color: var(--warning);
            }

            .log-entry {
                padding: 2px 0;
                line-height: 1.4;
            }

            .log-time {
                color: var(--text-secondary);
                margin-right: 8px;
            }

            .log-info {
                color: var(--text-primary);
            }

            .log-success {
                color: #4ec9b0;
            }

            .log-warn {
                color: var(--warning);
            }

            .log-error {
                color: var(--error);
            }

            .error-gutter {
                width: 16px;
            }

            .error-marker, .warning-marker {
                font-size: 12px;
                cursor: pointer;
                position: relative;
            }

            .error-marker {
                color: var(--error);
            }

            .warning-marker {
                color: var(--warning);
            }

            .error-marker:hover::after, .warning-marker:hover::after {
                content: attr(data-tooltip);
                position: absolute;
                left: 20px;
                top: -4px;
                background: #1e1e1e;
                color: var(--text-primary);
                padding: 8px 12px;
                border-radius: 4px;
                font-size: 12px;
                z-index: 1000;
                min-width: 300px;
                max-width: 600px;
                white-space: pre-wrap;
            }

            .error-marker:hover::after {
                border: 1px solid var(--error);
            }

            .warning-marker:hover::after {
                border: 1px solid var(--warning);
            }

            .error-line-bg {
                background: rgba(244, 76, 76, 0.15) !important;
            }

            .warning-line-bg {
                background: rgba(204, 167, 0, 0.15) !important;
            }

            .btn-settings {
                background: none !important;
                font-size: 18px;
                padding: 4px 8px !important;
                color: var(--text-secondary);
            }

            .btn-settings:hover {
                color: var(--text-primary) !important;
                background: none !important;
            }

            .settings-overlay {
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                z-index: 200;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .settings-overlay.hidden {
                display: none;
            }

            .settings-dialog {
                background: var(--bg-secondary);
                border: 1px solid var(--border);
                border-radius: 8px;
                width: 360px;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
            }

            .settings-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                border-bottom: 1px solid var(--border);
                font-size: 14px;
                font-weight: 500;
            }

            .settings-header button {
                background: none;
                border: none;
                color: var(--text-secondary);
                font-size: 18px;
                cursor: pointer;
                padding: 0 4px;
            }

            .settings-header button:hover {
                color: var(--text-primary);
            }

            .settings-body {
                padding: 16px;
            }

            .settings-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 8px;
            }

            .settings-label {
                font-size: 13px;
            }

            .settings-build-mode {
                background: var(--bg-tertiary);
                color: var(--text-primary);
                border: 1px solid var(--border);
                border-radius: 4px;
                padding: 6px 8px;
                font-size: 13px;
            }

            .settings-hint {
                font-size: 12px;
                color: var(--text-secondary);
                line-height: 1.5;
            }

            .settings-divider {
                height: 1px;
                background: var(--border);
                margin: 12px 0;
            }

            .settings-checkboxes {
                display: flex;
                flex-direction: column;
                gap: 6px;
                margin: 8px 0;
            }

            .settings-checkboxes label {
                font-size: 12px;
                color: var(--text-primary);
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .settings-logging-rules {
                width: 100%;
                background: var(--bg-tertiary);
                color: var(--text-primary);
                border: 1px solid var(--border);
                border-radius: 4px;
                padding: 6px 8px;
                font-family: 'Fira Code', monospace;
                font-size: 12px;
                resize: vertical;
                margin: 8px 0;
            }

            .btn-apply-logging {
                padding: 6px 12px;
                background: var(--accent);
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
                width: 100%;
            }

            .btn-apply-logging:hover {
                background: var(--accent-hover);
            }

            /* CodeMirror overrides */
            .CodeMirror {
                height: 100% !important;
                font-size: 14px;
                font-family: 'Fira Code', 'Consolas', 'Monaco', monospace;
            }
        `;
        this.shadow.appendChild(style);

        // Build HTML structure
        this.shadow.innerHTML += `
            <div class="toolbar">
                <div class="toolbar-left">
                    <button class="btn-run" title="Run (Ctrl+Enter)">Run</button>
                    <label class="auto-run-label">
                        <input type="checkbox" class="auto-run-checkbox" checked>
                        Auto
                    </label>
                </div>
                <div class="toolbar-title">QML Playground</div>
                <div class="toolbar-right">
                    <button class="btn-examples">Examples</button>
                    <div class="examples-dropdown hidden"></div>
                    <button class="btn-settings" title="Settings">&#9881;</button>
                </div>
            </div>

            <div class="settings-overlay hidden">
                <div class="settings-dialog">
                    <div class="settings-header">
                        <span>Settings</span>
                        <button class="btn-settings-close">&times;</button>
                    </div>
                    <div class="settings-body">
                        <div class="settings-row">
                            <label class="settings-label">Build Mode</label>
                            <select class="settings-build-mode">
                                <option value="static">Static (monolithic)</option>
                                <option value="shared">Shared (dynamic linking)</option>
                            </select>
                        </div>
                        <div class="settings-hint">
                            Static: all Qt modules linked into one binary.<br>
                            Shared: Qt modules loaded on demand (smaller initial download).
                        </div>
                        <div class="settings-divider"></div>
                        <div class="settings-label">Logging Categories</div>
                        <div class="settings-checkboxes">
                            <label><input type="checkbox" data-rule="qt.qml.import.debug=true"> qt.qml.import</label>
                            <label><input type="checkbox" data-rule="qt.qml.pluginloadblob.debug=true"> qt.qml.pluginloadblob</label>
                            <label><input type="checkbox" data-rule="qt.qml.typeresolution.debug=true"> qt.qml.typeresolution</label>
                            <label><input type="checkbox" data-rule="qt.qpa.debug=true"> qt.qpa</label>
                        </div>
                        <textarea class="settings-logging-rules" rows="3"
                            placeholder="e.g. qt.qml.import.debug=true"></textarea>
                        <button class="btn-apply-logging">Apply (reloads runtime)</button>
                    </div>
                </div>
            </div>

            <div class="main-container">
                <div class="editor-pane">
                    <textarea class="editor-textarea"></textarea>
                </div>
                <div class="resizer"></div>
                <div class="preview-pane">
                    <div class="qt-container"></div>
                    <div class="loading">
                        <div class="spinner"></div>
                        <div>Loading Qt runtime...</div>
                    </div>
                </div>
            </div>

            <div class="console-pane">
                <div class="console-header">
                    <span class="status-text">Loading...</span>
                    <button class="btn-toggle-console">▲</button>
                </div>
                <div class="console-content"></div>
            </div>
        `;

        // Cache element references
        this.editorElement = this.shadow.querySelector('.editor-textarea');
        this.containerElement = this.shadow.querySelector('.qt-container');
        this.statusElement = this.shadow.querySelector('.status-text');
        this.consoleElement = this.shadow.querySelector('.console-content');
        this.resizerElement = this.shadow.querySelector('.resizer');
        this.editorPaneElement = this.shadow.querySelector('.editor-pane');
        this.previewPaneElement = this.shadow.querySelector('.preview-pane');
        this.loadingElement = this.shadow.querySelector('.loading');
        this.runButtonElement = this.shadow.querySelector('.btn-run');
        this.autoRunCheckboxElement = this.shadow.querySelector('.auto-run-checkbox');
        this.examplesButtonElement = this.shadow.querySelector('.btn-examples');
        this.examplesDropdownElement = this.shadow.querySelector('.examples-dropdown');
        this.consolePaneElement = this.shadow.querySelector('.console-pane');
        this.consoleToggleElement = this.shadow.querySelector('.btn-toggle-console');
        this.consoleHeaderElement = this.shadow.querySelector('.console-header');
        this.settingsButtonElement = this.shadow.querySelector('.btn-settings');
        this.settingsOverlayElement = this.shadow.querySelector('.settings-overlay');
        this.settingsCloseElement = this.shadow.querySelector('.btn-settings-close');
        this.buildModeSelectElement = this.shadow.querySelector('.settings-build-mode');
        this.loggingRulesElement = this.shadow.querySelector('.settings-logging-rules');
        this.loggingCheckboxes = this.shadow.querySelectorAll('.settings-checkboxes input[type="checkbox"]');
        this.applyLoggingElement = this.shadow.querySelector('.btn-apply-logging');
    }

    // Initialize the playground
    async init() {
        await loadCodeMirror();
        registerQmlMode();
        this._initEditor();
        this._initUI();
        this._initResizer();
        await this._initRuntime();
        await this.loadExamples();
        await this.loadExample('hello.qml');
        return this;
    }

    // Initialize CodeMirror editor
    _initEditor() {
        if (!this.editorElement) return;

        this.editor = CodeMirror.fromTextArea(this.editorElement, {
            mode: 'qml',
            theme: 'gruvbox-dark',
            lineNumbers: true,
            gutters: ['CodeMirror-linenumbers', 'error-gutter'],
            indentUnit: 4,
            tabSize: 4,
            indentWithTabs: false,
            autoCloseBrackets: true,
            matchBrackets: true,
            extraKeys: {
                'Ctrl-Enter': () => this.run(),
                'Cmd-Enter': () => this.run(),
            }
        });

        // Auto-run on change with debounce
        this.editor.on('change', () => {
            if (!this.autoRun || !this.runtime?.ready || this._suppressAutoRun) return;

            if (this._autoRunTimeout) {
                clearTimeout(this._autoRunTimeout);
            }
            this._autoRunTimeout = setTimeout(() => this.run(), this.autoRunDelay);
        });

        this._emit('editorready');
        this.log('Editor initialized');
    }

    // Initialize UI elements
    _initUI() {
        // Run button
        this.runButtonElement?.addEventListener('click', () => this.run());

        // Auto-run checkbox
        if (this.autoRunCheckboxElement) {
            this.autoRunCheckboxElement.checked = this.autoRun;
            this.autoRunCheckboxElement.addEventListener('change', (e) => {
                this.autoRun = e.target.checked;
                this.log(`Auto-run ${this.autoRun ? 'enabled' : 'disabled'}`);
            });
        }

        // Examples button and dropdown
        if (this.examplesButtonElement && this.examplesDropdownElement) {
            this.examplesButtonElement.addEventListener('click', () => {
                this.examplesDropdownElement.classList.toggle('hidden');
            });

            // Close dropdown when clicking outside
            this.shadow.addEventListener('click', (e) => {
                if (!e.target.closest('.btn-examples') &&
                    !e.target.closest('.examples-dropdown')) {
                    this.examplesDropdownElement.classList.add('hidden');
                }
            });
        }

        // Settings button and dialog
        if (this.settingsButtonElement && this.settingsOverlayElement) {
            this.settingsButtonElement.addEventListener('click', () => {
                this.settingsOverlayElement.classList.remove('hidden');
            });
            this.settingsCloseElement.addEventListener('click', () => {
                this.settingsOverlayElement.classList.add('hidden');
            });
            this.settingsOverlayElement.addEventListener('click', (e) => {
                if (e.target === this.settingsOverlayElement) {
                    this.settingsOverlayElement.classList.add('hidden');
                }
            });

            // Build mode selector
            this.buildModeSelectElement.value = this.buildMode;
            this.buildModeSelectElement.addEventListener('change', (e) => {
                const mode = e.target.value;
                localStorage.setItem('qmlplayground-build-mode', mode);
                this.settingsOverlayElement.classList.add('hidden');
                this._loadRuntime(mode);
            });

            // Logging rules
            const savedRules = localStorage.getItem('qmlplayground-logging-rules') || '';
            this.loggingRulesElement.value = savedRules;
            this._syncLoggingCheckboxes(savedRules);

            // Checkboxes toggle rules in the textarea
            this.loggingCheckboxes.forEach(cb => {
                cb.addEventListener('change', () => {
                    this._syncLoggingTextFromCheckboxes();
                });
            });

            // Apply button
            this.applyLoggingElement.addEventListener('click', () => {
                const rules = this.loggingRulesElement.value.trim();
                localStorage.setItem('qmlplayground-logging-rules', rules);
                this.settingsOverlayElement.classList.add('hidden');
                this._loadRuntime(this.buildMode);
            });
        }

        // Console toggle
        if (this.consoleHeaderElement && this.consolePaneElement) {
            this.consoleHeaderElement.addEventListener('click', () => {
                this.consolePaneElement.classList.toggle('expanded');
                this.consoleToggleElement.textContent =
                    this.consolePaneElement.classList.contains('expanded') ? '▼' : '▲';
            });
        }

        this._setStatus('loading');
    }

    // Initialize resizer for panes
    _initResizer() {
        if (!this.resizerElement || !this.editorPaneElement || !this.previewPaneElement) return;

        this.resizerElement.addEventListener('pointerdown', (e) => {
            this.resizerElement.setPointerCapture(e.pointerId);
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });

        this.resizerElement.addEventListener('pointermove', (e) => {
            if (!this.resizerElement.hasPointerCapture(e.pointerId)) return;

            const container = this.editorPaneElement.parentElement;
            const containerRect = container.getBoundingClientRect();
            const percentage = ((e.clientX - containerRect.left) / containerRect.width) * 100;

            if (percentage > 20 && percentage < 80) {
                this.editorPaneElement.style.flex = 'none';
                this.editorPaneElement.style.width = percentage + '%';
                this.previewPaneElement.style.flex = '1';
            }
        });

        this.resizerElement.addEventListener('pointerup', (e) => {
            if (this.resizerElement.hasPointerCapture(e.pointerId)) {
                this.resizerElement.releasePointerCapture(e.pointerId);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                this.refresh();
            }
        });
    }

    // Sync checkbox state from a rules string
    _syncLoggingCheckboxes(rules) {
        this.loggingCheckboxes.forEach(cb => {
            cb.checked = rules.includes(cb.dataset.rule);
        });
    }

    // Build rules string from checkboxes + any extra lines in textarea
    _syncLoggingTextFromCheckboxes() {
        // Collect checked rules
        const checkedRules = [];
        this.loggingCheckboxes.forEach(cb => {
            if (cb.checked) checkedRules.push(cb.dataset.rule);
        });

        // Keep any manual lines that aren't covered by checkboxes
        const allCheckboxRules = new Set();
        this.loggingCheckboxes.forEach(cb => allCheckboxRules.add(cb.dataset.rule));

        const manualLines = this.loggingRulesElement.value
            .split('\n')
            .filter(line => line.trim() && !allCheckboxRules.has(line.trim()));

        this.loggingRulesElement.value = [...checkedRules, ...manualLines].join('\n');
    }

    // Initialize QmlRuntime
    async _initRuntime() {
        await this._loadRuntime(this.buildMode);
    }

    // Load (or reload) the Qt runtime for the given build mode
    async _loadRuntime(mode) {
        if (!this.containerElement) return;

        // Tear down existing runtime
        if (this.runtime) {
            this.runtime.destroy();
            this.runtime = null;
        }

        this.buildMode = mode;

        this._showLoading();
        this._setStatus('loading');
        this.log(`Loading Qt runtime (${mode})...`);

        const loggingRules = localStorage.getItem('qmlplayground-logging-rules') || '';
        this.runtime = new QmlRuntime(this.containerElement, { mode, loggingRules });

        this.runtime.on('loading', () => this._emit('loading'));
        this.runtime.on('ready', (detail) => {
            this._hideLoading();
            this._setStatus('ready');
            this.log(`Qt ${detail.qtVersion} ready [${mode}] (${detail.loadTime.toFixed(0)}ms)`, 'success');
            this._emit('ready', detail);
            // Run initial code if editor has content
            if (this.editor && this.editor.getValue().trim()) {
                this.run();
            }
        });
        this.runtime.on('error', (detail) => {
            this._showIssue({ ...detail, type: 'error' });
            this._emit('error', detail);
        });
        this.runtime.on('warning', (detail) => {
            this._showIssue({ ...detail, type: 'warning' });
            this._emit('warning', detail);
        });
        this.runtime.on('qmlloaded', () => {
            console.log('[playground] qmlloaded callback');
            this._checkErrors();
            this._emit('qmlloaded');
        });

        await this.runtime.load();
    }

    // Status bar
    _setStatus(status, count = 0) {
        if (!this.statusElement) return;

        const statusMap = {
            loading: { text: 'Loading...', className: 'status-text status-loading' },
            running: { text: 'Running...', className: 'status-text status-running' },
            error: { text: `${count} Error${count !== 1 ? 's' : ''}`, className: 'status-text status-error' },
            warning: { text: `${count} Warning${count !== 1 ? 's' : ''}`, className: 'status-text status-warning' },
            ready: { text: 'Ready', className: 'status-text status-ready' }
        };

        const s = statusMap[status] || statusMap.ready;
        this.statusElement.textContent = s.text;
        this.statusElement.className = s.className;
    }

    // Show loading overlay
    _showLoading() {
        this.loadingElement?.classList.remove('hidden');
        this.containerElement?.classList.remove('qt-ready');
    }

    // Hide loading overlay
    _hideLoading() {
        this.loadingElement?.classList.add('hidden');
        this.containerElement?.classList.add('qt-ready');
    }

    // Logging to console
    log(message, type = 'info') {
        if (!this.consoleElement) return;

        const entry = document.createElement('div');
        entry.className = `log-entry log-${type}`;
        const timestamp = new Date().toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            fractionalSecondDigits: 3
        });
        entry.innerHTML = `<span class="log-time">[${timestamp}]</span> ${message}`;
        this.consoleElement.appendChild(entry);
        this.consoleElement.scrollTop = this.consoleElement.scrollHeight;
    }

    // Get/set editor content
    getValue() {
        return this.editor?.getValue() ?? '';
    }

    _setValue(source) {
        if (this.editor) {
            this._suppressAutoRun = true;
            this.editor.setValue(source);
            this._suppressAutoRun = false;
        }
    }

    setValue(source) {
        this._setValue(source);
    }

    // Run the current editor content
    run() {
        if (!this.runtime?.ready) {
            this._emit('error', { line: 0, column: 0, message: 'Runtime not ready' });
            return;
        }

        const source = this.getValue();
        this._clearErrors();
        this._setStatus('running');
        this._emit('running');

        console.log('[playground] run: loading QML');

        try {
            this.runtime.loadQml(source);
            // Don't check errors here — wait for the qmlloaded callback
            // which fires after async plugin loading completes
        } catch (e) {
            console.log('[playground] run: exception:', e.message);
            this._showIssue({ line: 0, column: 0, message: e.message, type: 'error' });
            this._emit('error', { line: 0, column: 0, message: e.message });
        }
    }

    // Check and display errors from runtime
    _checkErrors() {
        const issues = this.runtime.getErrors();
        const errors = issues.filter(i => i.type === 'error' || !i.type);
        const warnings = issues.filter(i => i.type === 'warning');

        issues.forEach(issue => this._showIssue(issue));

        if (errors.length > 0) {
            this._setStatus('error', errors.length);
            this.log(`QML loaded with ${errors.length} error(s)`, 'error');
            errors.forEach(err => this.log(`  Line ${err.line}: ${err.message}`, 'error'));
            this._emit('errors', { errors, warnings });
        } else if (warnings.length > 0) {
            this._setStatus('warning', warnings.length);
            this.log(`QML loaded with ${warnings.length} warning(s)`, 'warn');
            warnings.forEach(warn => this.log(`  Line ${warn.line}: ${warn.message}`, 'warn'));
            this._emit('warnings', { warnings });
        } else {
            this._setStatus('ready');
            this.log('QML loaded successfully', 'success');
            this._emit('success');
        }
    }

    // Show error/warning in editor gutter
    _showIssue(issue) {
        if (!this.editor || issue.line <= 0) return;

        const lineIndex = issue.line - 1;
        const type = issue.type || 'error';
        const marker = this._makeMarker(issue.message, type);

        this.editor.setGutterMarker(lineIndex, 'error-gutter', marker);
        const bgClass = type === 'warning' ? 'warning-line-bg' : 'error-line-bg';
        this.editor.addLineClass(lineIndex, 'background', bgClass);
        this._errorMarkers.push({ line: lineIndex, type });
    }

    _makeMarker(message, type) {
        const marker = document.createElement('div');
        marker.className = type === 'warning' ? 'warning-marker' : 'error-marker';
        marker.innerHTML = '●';
        marker.setAttribute('data-tooltip', message);
        return marker;
    }

    _clearErrors() {
        if (!this.editor) return;

        for (const item of this._errorMarkers) {
            this.editor.setGutterMarker(item.line, 'error-gutter', null);
            this.editor.removeLineClass(item.line, 'background', 'error-line-bg');
            this.editor.removeLineClass(item.line, 'background', 'warning-line-bg');
        }
        this._errorMarkers = [];
    }

    // Refresh editor layout
    refresh() {
        this.editor?.refresh();
    }

    // Load examples index
    async loadExamples() {
        if (!this.examplesUrl) return [];

        try {
            const response = await fetch(this.examplesUrl);
            if (!response.ok) throw new Error('Failed to load examples index');
            this._examples = await response.json();
            this._buildExamplesDropdown();
            this.log(`Loaded ${this._examples.length} examples`);
            this._emit('examplesloaded', { examples: this._examples });
            return this._examples;
        } catch (e) {
            this.log(`Error loading examples: ${e.message}`, 'error');
            this._emit('error', { line: 0, column: 0, message: `Error loading examples: ${e.message}` });
            return [];
        }
    }

    // Build examples dropdown UI
    _buildExamplesDropdown() {
        if (!this.examplesDropdownElement) return;

        this.examplesDropdownElement.innerHTML = '';
        for (const example of this._examples) {
            const btn = document.createElement('button');
            btn.textContent = example.name;
            btn.addEventListener('click', () => {
                this.loadExample(example.name);
                this.examplesDropdownElement.classList.add('hidden');
            });
            this.examplesDropdownElement.appendChild(btn);
        }
    }

    getExamples() {
        return this._examples;
    }

    // Load a specific example by name or file
    async loadExample(nameOrFile) {
        const example = this._examples.find(e => e.name === nameOrFile || e.file === nameOrFile);
        if (!example) {
            this.log(`Example not found: ${nameOrFile}`, 'error');
            this._emit('error', { line: 0, column: 0, message: `Example not found: ${nameOrFile}` });
            return;
        }

        try {
            const baseUrl = this.examplesUrl.replace(/\/[^/]*$/, '/');
            const response = await fetch(baseUrl + example.file);
            if (!response.ok) throw new Error(`Failed to load ${example.file}`);
            const source = await response.text();
            this._setValue(source);
            this.log(`Loaded example: ${example.name}`);
            this._emit('exampleloaded', { example, source });
            this.run();
        } catch (e) {
            this.log(`Error loading example: ${e.message}`, 'error');
            this._emit('error', { line: 0, column: 0, message: `Error loading example: ${e.message}` });
        }
    }

    // Emit event
    _emit(type, detail = {}) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    // Convenience event listener
    on(event, callback) {
        this.addEventListener(event, (e) => callback(e.detail));
        return this;
    }
}

export { QmlPlayground };
