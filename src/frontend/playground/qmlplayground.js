// QmlPlayground - Self-contained QML playground component with Shadow DOM

import { QmlRuntime } from './qmlruntime.js';
import { QmlEditor } from './qmleditor.js';
import { QmlProject } from './qmlproject.js';
import { QmlAI } from './qmlai.js';
import {
    QmlAIUI,
    getAIModel,
    getAIOpenRouterKey,
    getAISystemPrompt,
    getAILocalEnabled,
    getAIOpenRouterEnabled,
    providerForModelId,
} from './qmlaiui.js';
import { QMLAI_DEFAULT_MODEL, OPENROUTER_DEFAULT_MODEL } from './qmlai.js';


class QmlPlayground extends EventTarget {
    static getBuildMode() {
        return localStorage.getItem('qmlplayground-build-mode') || 'static';
    }

    static getTheme() {
        return localStorage.getItem('qmlplayground-theme') || 'dark';
    }

    static getExperimentalExamples() {
        return localStorage.getItem('qmlplayground-experimental-examples') === 'true';
    }

    // Hot reload: patch the running scene in place on edits (default on).
    static getHotReload() {
        const stored = localStorage.getItem('qmlplayground-hot-reload');
        return stored === null ? true : stored === 'true';
    }

    // Accessibility: expose the scene to screen readers (default on).
    static getAccessibility() {
        const stored = localStorage.getItem('qmlplayground-accessibility');
        return stored === null ? true : stored === 'true';
    }

    static _resolveTheme(theme) {
        if (theme === 'system') {
            return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
                ? 'light' : 'dark';
        }
        return theme;
    }

    // @font-face inside shadow DOM is not reliably honored across browsers,
    // so the playground installs its bundled fonts into the document head once.
    static _injectFonts() {
        if (document.getElementById('qmlplayground-fonts')) return;
        const style = document.createElement('style');
        style.id = 'qmlplayground-fonts';
        style.textContent = `
            @font-face {
                font-family: 'Titillium Web';
                font-style: normal;
                font-weight: 400;
                font-display: swap;
                src: url('titillium-web/titillium-web-latin-400-normal.woff2') format('woff2');
            }
            @font-face {
                font-family: 'Titillium Web';
                font-style: normal;
                font-weight: 600;
                font-display: swap;
                src: url('titillium-web/titillium-web-latin-600-normal.woff2') format('woff2');
            }
            @font-face {
                font-family: 'Titillium Web';
                font-style: normal;
                font-weight: 700;
                font-display: swap;
                src: url('titillium-web/titillium-web-latin-700-normal.woff2') format('woff2');
            }
        `;
        document.head.appendChild(style);
    }

    constructor(container) {
        super();
        this.container = container || document.body;
        this.shadow = this.container.attachShadow({ mode: 'open' });
        this.buildMode = QmlPlayground.getBuildMode();
        this.theme = QmlPlayground.getTheme();

        // Options
        this.examplesUrl = 'examples/index.json';
        this.autoRun = true;
        this.autoRunDelay = 500;

        // Internal state
        this.runtime = null;
        this.editor = null;
        this.project = new QmlProject({ entry: 'Main.qml' });
        this.activePath = this.project.entry; // file currently shown in the editor
        const activeModelId = getAIModel();
        const activeProvider = providerForModelId(activeModelId);
        this.ai = new QmlAI({
            provider: activeProvider,
            modelId: activeProvider === 'webllm' ? activeModelId : QMLAI_DEFAULT_MODEL,
            openrouterKey: getAIOpenRouterKey(),
            openrouterModel: activeProvider === 'openrouter' ? activeModelId : OPENROUTER_DEFAULT_MODEL,
            systemPrompt: getAISystemPrompt(),
        });
        this.aiUI = null; // constructed in _buildDOM after the host DOM exists
        this._autoRunTimeout = null;
        this._examples = [];

        this._buildDOM();
    }

    _applyTheme() {
        const resolved = QmlPlayground._resolveTheme(this.theme);
        if (this.container && this.container.setAttribute) {
            this.container.setAttribute('data-theme', resolved);
        }
        this.editor?.setTheme(resolved);
        // Match the QML preview's color scheme to the theme (light/dark).
        this.runtime?.setColorScheme(resolved);
    }

    _buildDOM() {
        QmlPlayground._injectFonts();

        // Apply initial theme on the host element and listen for system pref changes.
        this._applyTheme();
        if (window.matchMedia) {
            const mql = window.matchMedia('(prefers-color-scheme: light)');
            const onChange = () => { if (this.theme === 'system') this._applyTheme(); };
            if (mql.addEventListener) mql.addEventListener('change', onChange);
            else if (mql.addListener) mql.addListener(onChange);
        }

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
                font-family: 'Titillium Web', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: var(--bg-primary);
                color: var(--text-primary);
            }

            :host([data-theme="light"]) {
                --bg-primary: #ffffff;
                --bg-secondary: #f3f3f3;
                --bg-tertiary: #e8e8e8;
                --text-primary: #1f1f1f;
                --text-secondary: #5a5a5a;
                --accent: #0066b8;
                --accent-hover: #1a78d6;
                --border: #d4d4d4;
                --error: #c62828;
                --warning: #8a6d00;
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
                position: relative;
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

            .file-tree {
                width: 180px;
                flex-shrink: 0;
                background: var(--bg-secondary);
                border-right: 1px solid var(--border);
                overflow-y: auto;
                padding: 8px 0;
            }

            .file-tree.hidden {
                display: none;
            }

            .file-tree-title {
                padding: 4px 12px 8px;
                font-size: 11px;
                color: var(--text-secondary);
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }

            .file-tree-item {
                display: block;
                width: 100%;
                padding: 6px 12px;
                background: none;
                border: none;
                color: var(--text-primary);
                text-align: left;
                cursor: pointer;
                font-size: 13px;
                font-family: 'Fira Code', monospace;
            }

            .file-tree-item:hover {
                background: var(--bg-tertiary);
            }

            .file-tree-item.active {
                background: var(--accent);
                color: white;
            }

            .file-tree-item.entry::before {
                content: '▶ ';
                color: var(--text-secondary);
                font-size: 10px;
            }

            .file-tree-item.active.entry::before {
                color: rgba(255, 255, 255, 0.8);
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
                left: 0;
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

            .examples-dropdown-header {
                padding: 8px 16px 4px;
                font-size: 11px;
                color: var(--text-secondary);
                text-transform: uppercase;
                letter-spacing: 0.5px;
                border-top: 1px solid var(--border);
                margin-top: 4px;
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
                font-size: x-large !important;
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
                width: 640px;
                max-width: 92vw;
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
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 16px 20px;
            }

            .settings-section {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .settings-section-wide {
                grid-column: 1 / -1;
            }

            .settings-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
            }

            .settings-label {
                font-size: 12px;
                color: var(--text-secondary);
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }

            .settings-build-mode,
            .settings-theme {
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

            .settings-checkboxes {
                display: flex;
                flex-direction: column;
                gap: 6px;
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

            .settings-ai-key-label {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 13px;
            }

            .settings-ai-key-label span {
                flex-shrink: 0;
            }

            .settings-ai-key-label input {
                flex: 1;
                background: var(--bg-tertiary);
                color: var(--text-primary);
                border: 1px solid var(--border);
                border-radius: 4px;
                padding: 6px 8px;
                font-size: 12px;
                font-family: 'Fira Code', monospace;
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
                    <button class="btn-examples">Examples</button>
                    <div class="examples-dropdown hidden"></div>
                    <button class="btn-run" title="Run (Ctrl+Enter)">Run</button>
                    <label class="auto-run-label">
                        <input type="checkbox" class="auto-run-checkbox" checked>
                        Auto
                    </label>
                </div>
                <div class="toolbar-title">QML Playground</div>
                <div class="toolbar-right">
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
                        <section class="settings-section">
                            <div class="settings-label">Theme</div>
                            <select class="settings-theme">
                                <option value="system">System</option>
                                <option value="dark">Dark</option>
                                <option value="light">Light</option>
                            </select>
                        </section>

                        <section class="settings-section">
                            <div class="settings-label">Build Mode</div>
                            <select class="settings-build-mode">
                                <option value="static">Static (monolithic)</option>
                                <option value="shared">Shared (dynamic linking)</option>
                            </select>
                            <div class="settings-hint">
                                Static: all Qt modules linked into one binary.<br>
                                Shared: Qt modules loaded on demand.
                            </div>
                        </section>

                        <section class="settings-section">
                            <div class="settings-label">Hot Reload</div>
                            <div class="settings-checkboxes">
                                <label><input type="checkbox" class="settings-hot-reload"> Patch the running scene in place</label>
                            </div>
                            <div class="settings-hint">
                                Edits update the live objects, which keep their state.<br>
                                Off: every run recreates the scene.
                            </div>
                        </section>

                        <section class="settings-section">
                            <div class="settings-label">Accessibility</div>
                            <div class="settings-checkboxes">
                                <label><input type="checkbox" class="settings-accessibility"> Expose the scene to screen readers</label>
                            </div>
                            <div class="settings-hint">
                                Qt mirrors the scene as accessible HTML elements.<br>
                                Changing this reloads the runtime.
                            </div>
                        </section>

                        <section class="settings-section settings-section-wide">
                            <div class="settings-label">Logging Categories</div>
                            <div class="settings-checkboxes">
                                <label><input type="checkbox" data-rule="qt.qml.import.debug=true"> qt.qml.import</label>
                                <label><input type="checkbox" data-rule="qt.qml.pluginloadblob.debug=true"> qt.qml.pluginloadblob</label>
                                <label><input type="checkbox" data-rule="qt.qml.typeresolution.debug=true"> qt.qml.typeresolution</label>
                                <label><input type="checkbox" data-rule="qt.qpa.debug=true"> qt.qpa</label>
                            </div>
                            <textarea class="settings-logging-rules" rows="3"
                                placeholder="e.g. qt.qml.import.debug=true"></textarea>
                        </section>

                        <section class="settings-section">
                            <div class="settings-label">Experimental</div>
                            <div class="settings-checkboxes">
                                <label><input type="checkbox" class="settings-experimental-examples"> Show experimental examples</label>
                            </div>
                        </section>

                        <section class="settings-section">
                            <div class="settings-label">AI</div>
                            <div class="settings-checkboxes">
                                <label><input type="checkbox" class="settings-ai-local-enabled"> Local (WebLLM, on-device)</label>
                                <label><input type="checkbox" class="settings-ai-openrouter-enabled"> OpenRouter (cloud)</label>
                            </div>
                            <div class="settings-ai-openrouter-key-row">
                                <label class="settings-ai-key-label">
                                    <span>API key</span>
                                    <input class="settings-ai-openrouter-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-or-..." disabled>
                                </label>
                            </div>
                        </section>
                    </div>
                </div>
            </div>


            <div class="main-container">
                <div class="file-tree hidden"></div>
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
        this.fileTreeElement = this.shadow.querySelector('.file-tree');
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
        this.themeSelectElement = this.shadow.querySelector('.settings-theme');
        this.buildModeSelectElement = this.shadow.querySelector('.settings-build-mode');
        this.experimentalExamplesElement = this.shadow.querySelector('.settings-experimental-examples');
        this.hotReloadElement = this.shadow.querySelector('.settings-hot-reload');
        this.accessibilityElement = this.shadow.querySelector('.settings-accessibility');
        this.aiLocalEnabledElement = this.shadow.querySelector('.settings-ai-local-enabled');
        this.aiOpenRouterEnabledElement = this.shadow.querySelector('.settings-ai-openrouter-enabled');
        this.aiOpenRouterKeyRowElement = this.shadow.querySelector('.settings-ai-openrouter-key-row');
        this.aiOpenRouterKeyElement = this.shadow.querySelector('.settings-ai-openrouter-key');
        this.loggingRulesElement = this.shadow.querySelector('.settings-logging-rules');
        this.loggingCheckboxes = this.shadow.querySelectorAll('.settings-checkboxes input[type="checkbox"][data-rule]');
        this.applyLoggingElement = this.shadow.querySelector('.btn-apply-logging');
        // (AI elements are queried by QmlAIUI after it mounts.)
    }

    // Initialize the playground
    async init() {
        await this._initEditor();
        this._initUI();
        this._initResizer();
        this._mountAIUI();
        await this._initRuntime();
        await this.loadExamples();
        await this.loadExample('hello.qml');
        return this;
    }

    _mountAIUI() {
        this.aiUI = new QmlAIUI(this.shadow, {
            ai: this.ai,
            editor: this.editor,
            replaceProject: (jsonObj) => this._loadProjectObject(jsonObj),
            setEditorContent: (text) => this._setValue(text),
            syncProjectFromEditor: () => {
                this.project.setFileContent(this.activePath, this.editor?.getValue() ?? '');
            },
            runQml: (qml) => this._runAndAwaitErrorsForQml(qml),
            log: (msg, type) => this.log(msg, type),
        });
        this.aiUI.mount();
    }

    // Run an arbitrary QML string in the runtime (without touching
    // this.project) and resolve with the resulting error list. Used by
    // the AI fix-loop to evaluate each attempt's output.
    _runAndAwaitErrorsForQml(qml) {
        return new Promise((resolve) => {
            const handler = () => {
                this.runtime.removeEventListener('qmlloaded', handler);
                const issues = this.runtime.getErrors() || [];
                resolve(issues.filter(i => i.type === 'error' || !i.type));
            };
            this.runtime.addEventListener('qmlloaded', handler);

            const tempProject = new QmlProject({
                entry: 'Main.qml',
                files: [{ path: 'Main.qml', content: qml }],
            });
            this._clearErrors();
            this._setStatus('running');
            this._emit('running');
            this._runInFlight = true;
            try {
                this.runtime.loadProject(tempProject);
            } catch (e) {
                this._showIssue({ line: 0, column: 0, message: e.message, type: 'error' });
                this.runtime.removeEventListener('qmlloaded', handler);
                resolve([{ line: 0, column: 0, message: e.message }]);
            }
        });
    }

    async _initEditor() {
        if (!this.editorElement) return;

        const resolved = QmlPlayground._resolveTheme(this.theme);
        this.editor = new QmlEditor(this.editorElement, { theme: resolved });
        await this.editor.init();

        this.editor.on('run', () => this.run());

        this.editor.on('change', () => {
            // Mirror the editor into the currently-active file in the project
            // so the project model stays in sync as the user types.
            this.project.setFileContent(this.activePath, this.editor.getValue());

            if (!this.autoRun || !this.runtime?.ready) return;

            if (this._runInFlight) {
                this._runPending = true;
                return;
            }
            if (this._autoRunTimeout) clearTimeout(this._autoRunTimeout);
            this._autoRunTimeout = setTimeout(() => this.run(), 50);
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

            // Qt-wasm installs document-level cut/copy/paste handlers that
            // preventDefault every clipboard event. Stop propagation here so
            // dialog inputs receive native paste.
            for (const ev of ['paste', 'copy', 'cut']) {
                this.settingsOverlayElement.addEventListener(ev, (e) => e.stopPropagation());
            }

            // Theme selector
            this.themeSelectElement.value = this.theme;
            this.themeSelectElement.addEventListener('change', (e) => {
                this.theme = e.target.value;
                localStorage.setItem('qmlplayground-theme', this.theme);
                this._applyTheme();
            });

            // Build mode selector — applies immediately, dialog stays open.
            this.buildModeSelectElement.value = this.buildMode;
            this.buildModeSelectElement.addEventListener('change', (e) => {
                const mode = e.target.value;
                localStorage.setItem('qmlplayground-build-mode', mode);
                this._loadRuntime(mode);
            });

            // Hot reload toggle. The view-level flag applies to the next run.
            // The service behind it has to be started with the runtime, so
            // turning it on for a runtime that was loaded without it reloads
            // the runtime (like a build mode change).
            if (this.hotReloadElement) {
                this.hotReloadElement.checked = QmlPlayground.getHotReload();
                this.hotReloadElement.addEventListener('change', (e) => {
                    const on = e.target.checked;
                    localStorage.setItem('qmlplayground-hot-reload', on);
                    if (!this.runtime) return;
                    this.runtime.hotReload = on;
                    if (on && !this.runtime.hotReloadAvailable) {
                        this._loadRuntime(this.buildMode);
                        return;
                    }
                    this.log(`Hot reload ${on ? 'enabled' : 'disabled'}`);
                });
            }

            // Accessibility toggle. QT_WASM_ENABLE_ACCESSIBILITY is read at
            // platform startup, so a change reloads the runtime.
            if (this.accessibilityElement) {
                this.accessibilityElement.checked = QmlPlayground.getAccessibility();
                this.accessibilityElement.addEventListener('change', (e) => {
                    localStorage.setItem('qmlplayground-accessibility', e.target.checked);
                    if (this.runtime)
                        this._loadRuntime(this.buildMode);
                });
            }

            // Experimental examples toggle
            if (this.experimentalExamplesElement) {
                this.experimentalExamplesElement.checked = QmlPlayground.getExperimentalExamples();
                this.experimentalExamplesElement.addEventListener('change', (e) => {
                    localStorage.setItem('qmlplayground-experimental-examples', e.target.checked);
                    this._buildExamplesDropdown();
                });
            }

            // AI provider toggles + OpenRouter key. Each option applies
            // immediately; the dialog stays open. The key input is
            // always visible but disabled until OpenRouter is checked.
            // QmlAIUI owns the AI button + panel; we just tell it to
            // refresh after a toggle.
            const syncAISubrows = () => {
                const orOn = !!this.aiOpenRouterEnabledElement?.checked;
                if (this.aiOpenRouterKeyElement)
                    this.aiOpenRouterKeyElement.disabled = !orOn;
            };
            if (this.aiLocalEnabledElement) {
                this.aiLocalEnabledElement.checked = getAILocalEnabled();
                this.aiLocalEnabledElement.addEventListener('change', (e) => {
                    localStorage.setItem('qmlplayground-ai-local-enabled', e.target.checked);
                    this.aiUI?.refresh();
                });
            }
            if (this.aiOpenRouterEnabledElement) {
                this.aiOpenRouterEnabledElement.checked = getAIOpenRouterEnabled();
                this.aiOpenRouterEnabledElement.addEventListener('change', (e) => {
                    localStorage.setItem('qmlplayground-ai-openrouter-enabled', e.target.checked);
                    this.aiUI?.refresh();
                    syncAISubrows();
                });
            }
            if (this.aiOpenRouterKeyElement) {
                this.aiOpenRouterKeyElement.value = getAIOpenRouterKey();
                this.aiOpenRouterKeyElement.addEventListener('input', (e) => {
                    const k = e.target.value;
                    if (k) localStorage.setItem('qmlplayground-ai-openrouter-key', k);
                    else   localStorage.removeItem('qmlplayground-ai-openrouter-key');
                    this.ai.setOpenRouterKey(k);
                });
            }
            syncAISubrows();

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

            // Logging rules apply on textarea blur (change event) — reloads
            // the runtime with the new rules; dialog stays open.
            this.loggingRulesElement.addEventListener('change', () => {
                const rules = this.loggingRulesElement.value.trim();
                localStorage.setItem('qmlplayground-logging-rules', rules);
                this._loadRuntime(this.buildMode);
            });
            // Toggling a checkbox already updates the textarea via the
            // existing handler; piggy-back to persist + reload.
            this.loggingCheckboxes.forEach(cb => {
                cb.addEventListener('change', () => {
                    const rules = this.loggingRulesElement.value.trim();
                    localStorage.setItem('qmlplayground-logging-rules', rules);
                    this._loadRuntime(this.buildMode);
                });
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
            // Suspend Qt canvas resize while dragging — see QmlRuntime
            // setResizeEnabled. Avoids per-frame black flash from the WebGL
            // buffer-clear.
            this.runtime?.setResizeEnabled(false);
        });

        this.resizerElement.addEventListener('pointermove', (e) => {
            if (!this.resizerElement.hasPointerCapture(e.pointerId)) return;

            // Compute the new editor width from its own left edge, not the
            // container's — there may be a file tree (or other sibling) to
            // the left of the editor pane.
            const editorRect = this.editorPaneElement.getBoundingClientRect();
            const containerRect = this.editorPaneElement.parentElement.getBoundingClientRect();
            const minEditor = 200;
            const minPreview = 200;
            const maxEditor = containerRect.right - editorRect.left - minPreview;
            const newWidth = Math.max(minEditor, Math.min(maxEditor, e.clientX - editorRect.left));

            this.editorPaneElement.style.flex = 'none';
            this.editorPaneElement.style.width = newWidth + 'px';
            this.previewPaneElement.style.flex = '1';
        });

        this.resizerElement.addEventListener('pointerup', (e) => {
            if (this.resizerElement.hasPointerCapture(e.pointerId)) {
                this.resizerElement.releasePointerCapture(e.pointerId);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                this.runtime?.setResizeEnabled(true);
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
        this.runtime = new QmlRuntime(this.containerElement, {
            mode, loggingRules,
            colorScheme: QmlPlayground._resolveTheme(this.theme),
            hotReload: QmlPlayground.getHotReload(),
            accessibility: QmlPlayground.getAccessibility(),
        });

        this.runtime.on('loading', () => this._emit('loading'));
        this.runtime.on('ready', (detail) => {
            this._hideLoading();
            this._setStatus('ready');
            this.log(`Qt ${detail.qtVersion} ready [${mode}] (${detail.loadTime.toFixed(0)}ms)`, 'success');
            if (QmlPlayground.getHotReload())
                this.log(`Hot reload ${this.runtime.hotReloadAvailable ? 'enabled' : 'unavailable in this runtime'}`);
            if (this.runtime.accessibility)
                this.log('Accessibility enabled');
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
        this.runtime.on('qmlloaded', (detail) => {
            console.log('[playground] qmlloaded callback', detail);
            this._lastLoadWasHot = !!detail?.hot;
            this._checkErrors();
            this._emit('qmlloaded');
            this._runComplete();
            if (this._refocusEditorOnLoad && this.editor) {
                this._refocusEditorOnLoad = false;
                this.editor.focus();
            }
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

    // Get/set editor content. The QmlProject mirrors the editor; for now
    // there is one file (the entry) so getValue reads either.
    getValue() {
        return this.editor?.getValue() ?? '';
    }

    _setValue(source) {
        this.editor?.setValue(source, { silent: true });
        this.project.setFileContent(this.activePath, source);
    }

    setValue(source) {
        this._setValue(source);
    }

    getProject() {
        return this.project;
    }

    // Run the current project (entry file resolved through MEMFS).
    run() {
        if (!this.runtime?.ready) {
            this._emit('error', { line: 0, column: 0, message: 'Runtime not ready' });
            return;
        }

        // Make sure the project reflects any in-flight editor edits before
        // we hand it to the runtime.
        this.project.setFileContent(this.activePath, this.getValue());

        this._clearErrors();
        this._setStatus('running');
        this._emit('running');

        console.log('[playground] run: loading project');
        this._runInFlight = true;
        // Showing a fresh QQuickWindow (e.g. ApplicationWindow) steals focus
        // from the editor. Remember whether the user was typing so we can
        // restore focus once the load completes.
        this._refocusEditorOnLoad = !!this.editor && this.editor.hasFocus();

        try {
            this.runtime.loadProject(this.project);
            // Don't check errors here — wait for the qmlloaded callback
            // which fires after async plugin loading completes
        } catch (e) {
            console.log('[playground] run: exception:', e.message, e.stack);
            this._showIssue({ line: 0, column: 0, message: e.message, type: 'error' });
            this._emit('error', { line: 0, column: 0, message: e.message });
            this._runComplete();
        }
    }

    // Check and display errors from runtime
    _runComplete() {
        this._runInFlight = false;
        if (this._runPending) {
            this._runPending = false;
            this.run();
        }
    }

    _checkErrors() {
        const issues = this.runtime.getErrors();
        const errors = issues.filter(i => i.type === 'error' || !i.type);
        const warnings = issues.filter(i => i.type === 'warning');
        const how = this._lastLoadWasHot ? 'hot reloaded' : 'loaded';

        issues.forEach(issue => this._showIssue(issue));

        if (errors.length > 0) {
            this._setStatus('error', errors.length);
            this.log(`QML ${how} with ${errors.length} error(s)`, 'error');
            errors.forEach(err => this.log(`  Line ${err.line}: ${err.message}`, 'error'));
            this._emit('errors', { errors, warnings });
        } else if (warnings.length > 0) {
            this._setStatus('warning', warnings.length);
            this.log(`QML ${how} with ${warnings.length} warning(s)`, 'warn');
            warnings.forEach(warn => this.log(`  Line ${warn.line}: ${warn.message}`, 'warn'));
            this._emit('warnings', { warnings });
        } else {
            this._setStatus('ready');
            this.log(`QML ${how} successfully`, 'success');
            this._emit('success');
        }
    }

    _showIssue(issue) {
        this.editor?.addMarker(issue.line, issue.column, issue.message, issue.type || 'error');
    }

    _clearErrors() {
        this.editor?.clearMarkers();
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

        const showExperimental = QmlPlayground.getExperimentalExamples();
        const stable = this._examples.filter(e => !e.experimental);
        const experimental = showExperimental
            ? this._examples.filter(e => e.experimental)
            : [];

        this.examplesDropdownElement.innerHTML = '';
        const appendItem = (example) => {
            const btn = document.createElement('button');
            btn.textContent = example.name;
            btn.addEventListener('click', () => {
                this.loadExample(example.name);
                this.examplesDropdownElement.classList.add('hidden');
            });
            this.examplesDropdownElement.appendChild(btn);
        };

        stable.forEach(appendItem);
        if (experimental.length > 0) {
            const header = document.createElement('div');
            header.className = 'examples-dropdown-header';
            header.textContent = 'Experimental';
            this.examplesDropdownElement.appendChild(header);
            experimental.forEach(appendItem);
        }
    }

    getExamples() {
        return this._examples;
    }

    // ---- AI mode ----


    // Load a specific example by name or file. Examples can be single-file
    // (entry has "file") or multi-file projects (entry has "project" with a
    // path to a v1 project.json).
    async loadExample(nameOrFile) {
        const example = this._examples.find(e =>
            e.name === nameOrFile || e.file === nameOrFile || e.project === nameOrFile);
        if (!example) {
            this.log(`Example not found: ${nameOrFile}`, 'error');
            this._emit('error', { line: 0, column: 0, message: `Example not found: ${nameOrFile}` });
            return;
        }

        const baseUrl = this.examplesUrl.replace(/\/[^/]*$/, '/');
        try {
            if (example.project) {
                const response = await fetch(baseUrl + example.project);
                if (!response.ok) throw new Error(`Failed to load ${example.project}`);
                const obj = await response.json();
                this._loadProjectObject(obj);
                this.log(`Loaded project example: ${example.name}`);
                this._emit('exampleloaded', { example });
                this.run();
            } else {
                const response = await fetch(baseUrl + example.file);
                if (!response.ok) throw new Error(`Failed to load ${example.file}`);
                const source = await response.text();
                // Switch back to a single-file project so the file tree hides.
                this._loadProjectObject({
                    $schema: 'qmlplayground/project/v1',
                    name: example.name,
                    entry: 'Main.qml',
                    files: [{ path: 'Main.qml', encoding: 'utf-8', content: source }],
                });
                this.log(`Loaded example: ${example.name}`);
                this._emit('exampleloaded', { example, source });
                this.run();
            }
        } catch (e) {
            this.log(`Error loading example: ${e.message}`, 'error');
            this._emit('error', { line: 0, column: 0, message: `Error loading example: ${e.message}` });
        }
    }

    // Replace the current project with the given v1 JSON object and refresh
    // the editor + file tree to reflect it.
    _loadProjectObject(obj) {
        this.project = QmlProject.fromJSON(obj);
        this.activePath = this.project.entry;
        this._rebuildFileTree();
        this.editor?.setValue(this.project.getFileContent(this.activePath), { silent: true });
    }

    // Make `path` the file the editor is editing. Saves any pending edits to
    // the previously-active file first.
    setActiveFile(path) {
        if (path === this.activePath) return;
        if (!this.project.hasFile(path)) return;
        // Flush current editor content into the file we're leaving.
        if (this.editor)
            this.project.setFileContent(this.activePath, this.editor.getValue());
        this.activePath = path;
        this.editor?.setValue(this.project.getFileContent(path), { silent: true });
        this._rebuildFileTree();
    }

    _rebuildFileTree() {
        if (!this.fileTreeElement) return;
        const multi = this.project.files.size > 1;
        this.fileTreeElement.classList.toggle('hidden', !multi);

        this.fileTreeElement.innerHTML = '';
        if (!multi) return;

        const title = document.createElement('div');
        title.className = 'file-tree-title';
        title.textContent = this.project.name || 'Project';
        this.fileTreeElement.appendChild(title);

        for (const path of this.project.listPaths()) {
            const btn = document.createElement('button');
            btn.className = 'file-tree-item';
            if (path === this.activePath) btn.classList.add('active');
            if (path === this.project.entry) btn.classList.add('entry');
            btn.textContent = path;
            btn.title = path === this.project.entry ? `${path} (entry)` : path;
            btn.addEventListener('click', () => this.setActiveFile(path));
            this.fileTreeElement.appendChild(btn);
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
