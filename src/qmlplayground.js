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
    constructor(container) {
        super();
        this.container = container || document.body;
        this.shadow = this.container.attachShadow({ mode: 'open' });

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

    // Initialize QmlRuntime
    async _initRuntime() {
        if (!this.containerElement) return;

        this._setStatus('loading');
        this.log('Loading Qt runtime...');

        this.runtime = new QmlRuntime(this.containerElement);

        this.runtime.on('loading', () => this._emit('loading'));
        this.runtime.on('ready', (detail) => {
            this._hideLoading();
            this._setStatus('ready');
            this.log(`Qt ${detail.qtVersion} ready (${detail.loadTime.toFixed(0)}ms)`, 'success');
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
        this.runtime.on('qmlloaded', () => this._emit('qmlloaded'));

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

        try {
            this.runtime.loadQml(source);
            setTimeout(() => this._checkErrors(), 100);
        } catch (e) {
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
