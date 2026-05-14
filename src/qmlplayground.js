// QmlPlayground - Self-contained QML playground component with Shadow DOM

import { QmlRuntime } from './qmlruntime.js';
import { QmlEditor } from './qmleditor.js';
import { QmlProject } from './qmlproject.js';
import { QmlAI, QMLAI_MODELS, QMLAI_DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT, hasWebGPU } from './qmlai.js';

const AI_DEFAULTS = {
    maxTokens:   1024,
    temperature: 0.2,
    maxAttempts: 3,
};

const AI_SAMPLE_PROMPTS = [
    'A button that fades to a different color when hovered',
    'A simple analog clock with hour, minute, and second hands',
    'A pulsing circle animation on a dark background',
    'A list of weather cards with city, temperature, and icon',
    'A sliding side drawer with three navigation links',
    'A spinning 3D cube on a gradient background',
];

// Strip a model's fenced markdown wrapper while the buffer is still
// streaming. Tolerates partial / unclosed fences so the editor doesn't
// flicker between fenced and unfenced views during streaming.
function stripFencesProgressive(text) {
    let s = text;
    // Drop a leading ```qml / ```QML / ``` fence (with or without lang).
    const leading = s.match(/^\s*```(?:qml|QML|qt)?\s*\n?/);
    if (leading) s = s.slice(leading[0].length);
    // Drop a trailing ``` if the model has emitted it.
    s = s.replace(/\n?```\s*$/, '');
    return s;
}


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

    static getAIEnabled() {
        return localStorage.getItem('qmlplayground-ai-enabled') === 'true';
    }

    static getAIModel() {
        return localStorage.getItem('qmlplayground-ai-model') || QMLAI_DEFAULT_MODEL;
    }

    static getAISystemPrompt() {
        return localStorage.getItem('qmlplayground-ai-system-prompt') || DEFAULT_SYSTEM_PROMPT;
    }

    static _getNumberSetting(key, fallback, { min, max } = {}) {
        const raw = localStorage.getItem(key);
        if (raw == null) return fallback;
        const n = Number(raw);
        if (!Number.isFinite(n)) return fallback;
        if (min != null && n < min) return min;
        if (max != null && n > max) return max;
        return n;
    }

    static getAIMaxTokens() {
        return QmlPlayground._getNumberSetting(
            'qmlplayground-ai-max-tokens', AI_DEFAULTS.maxTokens, { min: 64, max: 8192 });
    }

    static getAITemperature() {
        return QmlPlayground._getNumberSetting(
            'qmlplayground-ai-temperature', AI_DEFAULTS.temperature, { min: 0, max: 2 });
    }

    static getAIMaxAttempts() {
        return QmlPlayground._getNumberSetting(
            'qmlplayground-ai-max-attempts', AI_DEFAULTS.maxAttempts, { min: 1, max: 10 });
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
        this.ai = new QmlAI({
            modelId: QmlPlayground.getAIModel(),
            systemPrompt: QmlPlayground.getAISystemPrompt(),
        });
        this._aiLog = []; // { ts, type: 'prompt'|'response'|'errors'|'info', text }
        this._aiAttempts = []; // { idx, label, qml, status: 'pending'|'ok'|'fail' }
        this._aiActiveAttempt = -1;
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

            /* AI mode */
            .btn-ai {
                background: linear-gradient(135deg, #9aa0ff 0%, #5f73ff 100%) !important;
                color: white;
            }

            .btn-ai.hidden {
                display: none;
            }

            .ai-panel {
                background: var(--bg-secondary);
                border-bottom: 1px solid var(--border);
                padding: 8px 10px;
                display: flex;
                flex-direction: column;
                gap: 8px;
                flex-shrink: 0;
            }

            .ai-panel.hidden {
                display: none;
            }

            .ai-panel-row {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .ai-model {
                flex: 1;
                background: var(--bg-tertiary);
                color: var(--text-primary);
                border: 1px solid var(--border);
                border-radius: 4px;
                padding: 6px 8px;
                font-size: 12px;
                font-family: inherit;
            }

            .ai-prompt {
                background: var(--bg-tertiary);
                color: var(--text-primary);
                border: 1px solid var(--border);
                border-radius: 4px;
                padding: 8px 10px;
                font-size: 13px;
                font-family: inherit;
                line-height: 1.4;
                resize: vertical;
                min-height: 56px;
            }

            .ai-prompt:focus {
                outline: none;
                border-color: var(--accent);
            }

            .ai-status {
                flex: 1;
                font-size: 12px;
                color: var(--text-secondary);
                min-height: 16px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .btn-ai-suggestions,
            .btn-ai-systemprompt,
            .btn-ai-params,
            .btn-ai-log {
                padding: 6px 10px !important;
                background: var(--bg-tertiary) !important;
                color: var(--text-primary);
                border: 1px solid var(--border);
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 400;
            }

            .btn-ai-suggestions:hover,
            .btn-ai-systemprompt:hover,
            .btn-ai-params:hover,
            .btn-ai-log:hover {
                border-color: var(--accent);
            }

            .btn-ai-generate {
                padding: 6px 14px;
                background: var(--accent);
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 500;
            }

            .btn-ai-generate:hover {
                background: var(--accent-hover);
            }

            .btn-ai-generate.hidden {
                display: none;
            }

            .btn-ai-cancel {
                padding: 6px 14px;
                background: var(--error);
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 500;
            }

            .btn-ai-cancel.hidden {
                display: none;
            }

            .btn-ai-cancel:hover {
                filter: brightness(1.1);
            }

            .ai-progress {
                height: 4px;
                background: var(--bg-tertiary);
                border-radius: 2px;
                overflow: hidden;
            }

            .ai-progress.hidden {
                display: none;
            }

            .ai-progress-bar {
                height: 100%;
                width: 0;
                background: var(--accent);
                transition: width 0.15s linear;
            }

            .ai-tabs {
                display: flex;
                flex-wrap: wrap;
                gap: 2px;
                padding: 4px 8px;
                background: var(--bg-secondary);
                border-bottom: 1px solid var(--border);
                flex-shrink: 0;
            }

            .ai-tabs.hidden {
                display: none;
            }

            .ai-tab {
                padding: 4px 10px;
                background: var(--bg-tertiary) !important;
                color: var(--text-primary);
                border: 1px solid var(--border);
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                white-space: nowrap;
            }

            .ai-tab:hover {
                border-color: var(--accent);
            }

            .ai-tab.active {
                background: var(--accent) !important;
                color: white;
                border-color: var(--accent);
            }

            .ai-tab.ai-tab-pending {
                font-style: italic;
            }

            .ai-tab.ai-tab-ok      { color: #4caf50; }
            .ai-tab.ai-tab-fail    { color: var(--error); }
            .ai-tab.active.ai-tab-ok,
            .ai-tab.active.ai-tab-fail { color: white; }

            /* Suggestions popover */
            .ai-suggestions-overlay {
                position: absolute;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                z-index: 200;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .ai-suggestions-overlay.hidden {
                display: none;
            }

            .ai-suggestions-dialog {
                background: var(--bg-secondary);
                border: 1px solid var(--border);
                border-radius: 8px;
                width: 440px;
                max-width: 90vw;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
            }

            .ai-suggestions-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                border-bottom: 1px solid var(--border);
                font-size: 14px;
                font-weight: 500;
            }

            .ai-suggestions-header button {
                background: none !important;
                color: var(--text-secondary);
                font-size: 20px;
                padding: 0 4px !important;
            }

            .ai-samples {
                display: flex;
                flex-direction: column;
                gap: 4px;
                padding: 12px 16px;
            }

            .ai-samples button {
                background: var(--bg-tertiary) !important;
                color: var(--text-primary);
                border: 1px solid var(--border);
                border-radius: 4px;
                padding: 8px 12px;
                font-size: 13px;
                text-align: left;
                cursor: pointer;
            }

            .ai-samples button:hover {
                border-color: var(--accent);
            }

            /* System-prompt + Loop-log + Params dialogs */
            .ai-systemprompt-overlay,
            .ai-log-overlay,
            .ai-params-overlay {
                position: absolute;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                z-index: 200;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .ai-systemprompt-overlay.hidden,
            .ai-log-overlay.hidden,
            .ai-params-overlay.hidden {
                display: none;
            }

            .ai-systemprompt-dialog,
            .ai-log-dialog,
            .ai-params-dialog {
                background: var(--bg-secondary);
                border: 1px solid var(--border);
                border-radius: 8px;
                width: 720px;
                max-width: 92vw;
                max-height: 80vh;
                display: flex;
                flex-direction: column;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
            }

            .ai-params-dialog { width: 520px; }

            .ai-systemprompt-header,
            .ai-log-header,
            .ai-params-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                border-bottom: 1px solid var(--border);
                font-size: 14px;
                font-weight: 500;
                gap: 8px;
            }

            .ai-systemprompt-header span,
            .ai-log-header span,
            .ai-params-header span {
                flex: 1;
            }

            .ai-systemprompt-header button,
            .ai-log-header button,
            .ai-params-header button {
                background: var(--bg-tertiary) !important;
                color: var(--text-primary);
                padding: 4px 8px !important;
                font-size: 12px;
            }

            .btn-ai-systemprompt-close,
            .btn-ai-log-close,
            .btn-ai-params-close {
                background: none !important;
                color: var(--text-secondary) !important;
                font-size: 20px !important;
                padding: 0 4px !important;
            }

            .ai-params-body {
                padding: 12px 16px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .ai-params-info {
                font-size: 12px;
                color: var(--text-secondary);
                padding-bottom: 4px;
                border-bottom: 1px solid var(--border);
                margin-bottom: 4px;
            }

            .ai-params-row-input {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 13px;
            }

            .ai-params-row-input span {
                flex: 1;
            }

            .ai-params-row-input input {
                width: 100px;
                background: var(--bg-tertiary);
                color: var(--text-primary);
                border: 1px solid var(--border);
                border-radius: 4px;
                padding: 6px 8px;
                font-size: 13px;
                font-family: inherit;
            }

            .ai-params-hint {
                font-size: 11px;
                color: var(--text-secondary);
                margin: 0 0 4px;
            }

            .ai-params-row {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-top: 4px;
            }

            .btn-ai-params-save,
            .btn-ai-params-reset {
                padding: 6px 12px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
            }

            .btn-ai-params-save {
                background: var(--accent);
                color: white;
                border: none;
            }

            .btn-ai-params-save:hover {
                background: var(--accent-hover);
            }

            .btn-ai-params-reset {
                background: var(--bg-tertiary);
                color: var(--text-primary);
                border: 1px solid var(--border);
            }

            .ai-systemprompt-body {
                padding: 12px 16px;
                display: flex;
                flex-direction: column;
                gap: 8px;
                overflow: auto;
            }

            .ai-systemprompt-text {
                background: var(--bg-tertiary);
                color: var(--text-primary);
                border: 1px solid var(--border);
                border-radius: 4px;
                padding: 10px 12px;
                font-size: 12px;
                font-family: 'Fira Code', monospace;
                line-height: 1.5;
                resize: vertical;
                min-height: 280px;
            }

            .ai-systemprompt-row {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .ai-systemprompt-hint {
                flex: 1;
                font-size: 11px;
                color: var(--text-secondary);
            }

            .btn-ai-systemprompt-save,
            .btn-ai-systemprompt-reset {
                padding: 6px 12px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
            }

            .btn-ai-systemprompt-save {
                background: var(--accent);
                color: white;
                border: none;
            }

            .btn-ai-systemprompt-save:hover {
                background: var(--accent-hover);
            }

            .btn-ai-systemprompt-reset {
                background: var(--bg-tertiary);
                color: var(--text-primary);
                border: 1px solid var(--border);
            }

            .ai-log-body {
                padding: 8px 16px;
                overflow: auto;
                font-family: 'Fira Code', monospace;
                font-size: 12px;
                line-height: 1.45;
                flex: 1;
            }

            .ai-log-entry {
                margin: 8px 0;
                border-left: 3px solid var(--border);
                padding-left: 10px;
            }

            .ai-log-entry.ai-log-prompt    { border-color: #5f73ff; }
            .ai-log-entry.ai-log-directive { border-color: #cca700; }
            .ai-log-entry.ai-log-response  { border-color: #4caf50; }
            .ai-log-entry.ai-log-errors    { border-color: var(--error); }
            .ai-log-entry.ai-log-info      { border-color: var(--text-secondary); }

            .ai-log-meta {
                color: var(--text-secondary);
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                margin-bottom: 2px;
            }

            .ai-log-text {
                white-space: pre-wrap;
                word-break: break-word;
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
                    <button class="btn-examples">Examples</button>
                    <div class="examples-dropdown hidden"></div>
                    <button class="btn-run" title="Run (Ctrl+Enter)">Run</button>
                    <label class="auto-run-label">
                        <input type="checkbox" class="auto-run-checkbox" checked>
                        Auto
                    </label>
                    <button class="btn-ai hidden" title="Generate a QML project from a prompt">AI mode</button>
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
                        <div class="settings-row">
                            <label class="settings-label">Theme</label>
                            <select class="settings-theme">
                                <option value="system">System</option>
                                <option value="dark">Dark</option>
                                <option value="light">Light</option>
                            </select>
                        </div>
                        <div class="settings-divider"></div>
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
                        <div class="settings-divider"></div>
                        <div class="settings-label">Experimental</div>
                        <div class="settings-checkboxes">
                            <label><input type="checkbox" class="settings-experimental-examples"> Show experimental examples</label>
                            <label><input type="checkbox" class="settings-ai-enabled"> Enable AI mode (stubbed; real WebLLM hookup later)</label>
                        </div>
                    </div>
                </div>
            </div>

            <div class="ai-suggestions-overlay hidden">
                <div class="ai-suggestions-dialog">
                    <div class="ai-suggestions-header">
                        <span>Suggestions</span>
                        <button class="btn-ai-suggestions-close">&times;</button>
                    </div>
                    <div class="ai-samples"></div>
                </div>
            </div>

            <div class="ai-systemprompt-overlay hidden">
                <div class="ai-systemprompt-dialog">
                    <div class="ai-systemprompt-header">
                        <span>System prompt</span>
                        <button class="btn-ai-systemprompt-close">&times;</button>
                    </div>
                    <div class="ai-systemprompt-body">
                        <textarea class="ai-systemprompt-text" rows="14"></textarea>
                        <div class="ai-systemprompt-row">
                            <button class="btn-ai-systemprompt-reset" type="button">Reset to default</button>
                            <span class="ai-systemprompt-hint">Saved to localStorage; applies on next Generate.</span>
                            <button class="btn-ai-systemprompt-save" type="button">Save</button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="ai-log-overlay hidden">
                <div class="ai-log-dialog">
                    <div class="ai-log-header">
                        <span>Loop log</span>
                        <button class="btn-ai-log-clear" type="button" title="Clear">Clear</button>
                        <button class="btn-ai-log-close">&times;</button>
                    </div>
                    <div class="ai-log-body"></div>
                </div>
            </div>

            <div class="ai-params-overlay hidden">
                <div class="ai-params-dialog">
                    <div class="ai-params-header">
                        <span>Model parameters</span>
                        <button class="btn-ai-params-close">&times;</button>
                    </div>
                    <div class="ai-params-body">
                        <div class="ai-params-info"></div>

                        <label class="ai-params-row-input">
                            <span>Max tokens (response cap)</span>
                            <input class="ai-params-maxtokens" type="number" min="64" max="8192" step="64">
                        </label>
                        <div class="ai-params-hint">
                            Total tokens (prompt + response) must fit in the model's context window.
                            If output is truncated, try lowering this or pick a model with more context.
                        </div>

                        <label class="ai-params-row-input">
                            <span>Temperature (0.0 – 2.0)</span>
                            <input class="ai-params-temperature" type="number" min="0" max="2" step="0.05">
                        </label>
                        <div class="ai-params-hint">
                            Lower = more deterministic. Each retry attempt bumps this by +0.2 (capped at 0.8).
                        </div>

                        <label class="ai-params-row-input">
                            <span>Max fix attempts</span>
                            <input class="ai-params-maxattempts" type="number" min="1" max="10" step="1">
                        </label>
                        <div class="ai-params-hint">
                            Total attempts before giving up (initial + retries on errors).
                        </div>

                        <div class="ai-params-row">
                            <button class="btn-ai-params-reset" type="button">Reset to defaults</button>
                            <span class="ai-params-hint" style="flex:1">Saved to localStorage; applied on next Generate.</span>
                            <button class="btn-ai-params-save" type="button">Save</button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="main-container">
                <div class="file-tree hidden"></div>
                <div class="editor-pane">
                    <div class="ai-panel hidden">
                        <div class="ai-panel-row">
                            <select class="ai-model"></select>
                        </div>
                        <textarea class="ai-prompt" rows="3"
                            placeholder="Describe a QML scene — e.g. A button that fades to a different color when hovered"></textarea>
                        <div class="ai-panel-row">
                            <button class="btn-ai-suggestions" type="button">Suggestions</button>
                            <button class="btn-ai-systemprompt" type="button" title="View / edit system prompt">System prompt</button>
                            <button class="btn-ai-params" type="button" title="Generation parameters (max_tokens, temperature, max attempts)">Params</button>
                            <button class="btn-ai-log" type="button" title="Loop log">Loop log</button>
                            <span class="ai-status"></span>
                            <button class="btn-ai-generate" type="button">Generate</button>
                            <button class="btn-ai-cancel hidden" type="button">Cancel</button>
                        </div>
                        <div class="ai-progress hidden">
                            <div class="ai-progress-bar"></div>
                        </div>
                    </div>
                    <div class="ai-tabs hidden"></div>
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
        this.aiEnabledElement = this.shadow.querySelector('.settings-ai-enabled');
        this.loggingRulesElement = this.shadow.querySelector('.settings-logging-rules');
        this.loggingCheckboxes = this.shadow.querySelectorAll('.settings-checkboxes input[type="checkbox"][data-rule]');
        this.applyLoggingElement = this.shadow.querySelector('.btn-apply-logging');
        this.aiButtonElement = this.shadow.querySelector('.btn-ai');
        this.aiPanelElement = this.shadow.querySelector('.ai-panel');
        this.aiTabsElement = this.shadow.querySelector('.ai-tabs');
        this.aiModelElement = this.shadow.querySelector('.ai-model');
        this.aiPromptElement = this.shadow.querySelector('.ai-prompt');
        this.aiSamplesElement = this.shadow.querySelector('.ai-samples');
        this.aiStatusElement = this.shadow.querySelector('.ai-status');
        this.aiProgressElement = this.shadow.querySelector('.ai-progress');
        this.aiProgressBarElement = this.shadow.querySelector('.ai-progress-bar');
        this.aiGenerateElement = this.shadow.querySelector('.btn-ai-generate');
        this.aiCancelElement = this.shadow.querySelector('.btn-ai-cancel');
        this.aiSuggestionsButtonElement = this.shadow.querySelector('.btn-ai-suggestions');
        this.aiSuggestionsOverlayElement = this.shadow.querySelector('.ai-suggestions-overlay');
        this.aiSuggestionsCloseElement = this.shadow.querySelector('.btn-ai-suggestions-close');
        this.aiSystemPromptButtonElement = this.shadow.querySelector('.btn-ai-systemprompt');
        this.aiSystemPromptOverlayElement = this.shadow.querySelector('.ai-systemprompt-overlay');
        this.aiSystemPromptCloseElement = this.shadow.querySelector('.btn-ai-systemprompt-close');
        this.aiSystemPromptTextElement = this.shadow.querySelector('.ai-systemprompt-text');
        this.aiSystemPromptSaveElement = this.shadow.querySelector('.btn-ai-systemprompt-save');
        this.aiSystemPromptResetElement = this.shadow.querySelector('.btn-ai-systemprompt-reset');
        this.aiLogButtonElement = this.shadow.querySelector('.btn-ai-log');
        this.aiLogOverlayElement = this.shadow.querySelector('.ai-log-overlay');
        this.aiLogCloseElement = this.shadow.querySelector('.btn-ai-log-close');
        this.aiLogClearElement = this.shadow.querySelector('.btn-ai-log-clear');
        this.aiLogBodyElement = this.shadow.querySelector('.ai-log-body');
        this.aiParamsButtonElement = this.shadow.querySelector('.btn-ai-params');
        this.aiParamsOverlayElement = this.shadow.querySelector('.ai-params-overlay');
        this.aiParamsCloseElement = this.shadow.querySelector('.btn-ai-params-close');
        this.aiParamsInfoElement = this.shadow.querySelector('.ai-params-info');
        this.aiParamsMaxTokensElement = this.shadow.querySelector('.ai-params-maxtokens');
        this.aiParamsTemperatureElement = this.shadow.querySelector('.ai-params-temperature');
        this.aiParamsMaxAttemptsElement = this.shadow.querySelector('.ai-params-maxattempts');
        this.aiParamsSaveElement = this.shadow.querySelector('.btn-ai-params-save');
        this.aiParamsResetElement = this.shadow.querySelector('.btn-ai-params-reset');
    }

    // Initialize the playground
    async init() {
        await this._initEditor();
        this._initUI();
        this._initResizer();
        await this._initRuntime();
        await this.loadExamples();
        await this.loadExample('hello.qml');
        return this;
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

            // Theme selector
            this.themeSelectElement.value = this.theme;
            this.themeSelectElement.addEventListener('change', (e) => {
                this.theme = e.target.value;
                localStorage.setItem('qmlplayground-theme', this.theme);
                this._applyTheme();
            });

            // Build mode selector
            this.buildModeSelectElement.value = this.buildMode;
            this.buildModeSelectElement.addEventListener('change', (e) => {
                const mode = e.target.value;
                localStorage.setItem('qmlplayground-build-mode', mode);
                this.settingsOverlayElement.classList.add('hidden');
                this._loadRuntime(mode);
            });

            // Experimental examples toggle
            if (this.experimentalExamplesElement) {
                this.experimentalExamplesElement.checked = QmlPlayground.getExperimentalExamples();
                this.experimentalExamplesElement.addEventListener('change', (e) => {
                    localStorage.setItem('qmlplayground-experimental-examples', e.target.checked);
                    this._buildExamplesDropdown();
                });
            }

            // AI mode toggle
            if (this.aiEnabledElement) {
                this.aiEnabledElement.checked = QmlPlayground.getAIEnabled();
                this._applyAIVisibility();
                this.aiEnabledElement.addEventListener('change', (e) => {
                    localStorage.setItem('qmlplayground-ai-enabled', e.target.checked);
                    this._applyAIVisibility();
                });
            }
            this._initAIDialog();

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

    _applyAIVisibility() {
        const enabled = QmlPlayground.getAIEnabled();
        this.aiButtonElement?.classList.toggle('hidden', !enabled);
        if (!enabled && this.aiPanelElement)
            this.aiPanelElement.classList.add('hidden');
    }

    _initAIDialog() {
        if (!this.aiButtonElement || !this.aiPanelElement) return;

        // Populate model selector
        if (this.aiModelElement) {
            this.aiModelElement.innerHTML = '';
            for (const m of QMLAI_MODELS) {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = m.label;
                this.aiModelElement.appendChild(opt);
            }
            this.aiModelElement.value = QmlPlayground.getAIModel();
            this.aiModelElement.addEventListener('change', (e) => {
                localStorage.setItem('qmlplayground-ai-model', e.target.value);
                this.ai.setModel(e.target.value);
                this._setAIStatus('Model will load on next Generate.');
            });
        }

        // Populate sample prompts (in the Suggestions popover)
        if (this.aiSamplesElement) {
            this.aiSamplesElement.innerHTML = '';
            for (const sample of AI_SAMPLE_PROMPTS) {
                const btn = document.createElement('button');
                btn.textContent = sample;
                btn.addEventListener('click', () => {
                    if (this.aiPromptElement) {
                        this.aiPromptElement.value = sample;
                        this.aiPromptElement.focus();
                    }
                    this._closeSuggestions();
                });
                this.aiSamplesElement.appendChild(btn);
            }
        }

        // Toolbar AI button toggles the inline panel
        this.aiButtonElement.addEventListener('click', () => {
            const hidden = this.aiPanelElement.classList.toggle('hidden');
            if (!hidden) {
                this.aiPromptElement?.focus();
                this.editor?.refresh();
            }
        });

        // Suggestions popover open/close
        this.aiSuggestionsButtonElement?.addEventListener('click', () => {
            this.aiSuggestionsOverlayElement?.classList.remove('hidden');
        });
        this.aiSuggestionsCloseElement?.addEventListener('click', () => this._closeSuggestions());
        this.aiSuggestionsOverlayElement?.addEventListener('click', (e) => {
            if (e.target === this.aiSuggestionsOverlayElement) this._closeSuggestions();
        });

        // System prompt dialog
        this.aiSystemPromptButtonElement?.addEventListener('click', () => {
            if (this.aiSystemPromptTextElement)
                this.aiSystemPromptTextElement.value = this.ai.getSystemPrompt();
            this.aiSystemPromptOverlayElement?.classList.remove('hidden');
        });
        const closeSysPrompt = () => this.aiSystemPromptOverlayElement?.classList.add('hidden');
        this.aiSystemPromptCloseElement?.addEventListener('click', closeSysPrompt);
        this.aiSystemPromptOverlayElement?.addEventListener('click', (e) => {
            if (e.target === this.aiSystemPromptOverlayElement) closeSysPrompt();
        });
        this.aiSystemPromptSaveElement?.addEventListener('click', () => {
            const text = this.aiSystemPromptTextElement?.value ?? '';
            this.ai.setSystemPrompt(text);
            localStorage.setItem('qmlplayground-ai-system-prompt', text);
            closeSysPrompt();
        });
        this.aiSystemPromptResetElement?.addEventListener('click', () => {
            if (this.aiSystemPromptTextElement)
                this.aiSystemPromptTextElement.value = DEFAULT_SYSTEM_PROMPT;
            this.ai.setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
            localStorage.removeItem('qmlplayground-ai-system-prompt');
        });

        // Params dialog
        this.aiParamsButtonElement?.addEventListener('click', () => {
            this._populateAIParams();
            this.aiParamsOverlayElement?.classList.remove('hidden');
        });
        const closeParams = () => this.aiParamsOverlayElement?.classList.add('hidden');
        this.aiParamsCloseElement?.addEventListener('click', closeParams);
        this.aiParamsOverlayElement?.addEventListener('click', (e) => {
            if (e.target === this.aiParamsOverlayElement) closeParams();
        });
        this.aiParamsSaveElement?.addEventListener('click', () => {
            const mt = Number(this.aiParamsMaxTokensElement?.value);
            const t  = Number(this.aiParamsTemperatureElement?.value);
            const ma = Number(this.aiParamsMaxAttemptsElement?.value);
            if (Number.isFinite(mt)) localStorage.setItem('qmlplayground-ai-max-tokens', String(mt));
            if (Number.isFinite(t))  localStorage.setItem('qmlplayground-ai-temperature', String(t));
            if (Number.isFinite(ma)) localStorage.setItem('qmlplayground-ai-max-attempts', String(ma));
            closeParams();
        });
        this.aiParamsResetElement?.addEventListener('click', () => {
            localStorage.removeItem('qmlplayground-ai-max-tokens');
            localStorage.removeItem('qmlplayground-ai-temperature');
            localStorage.removeItem('qmlplayground-ai-max-attempts');
            this._populateAIParams();
        });

        // Loop log dialog
        this.aiLogButtonElement?.addEventListener('click', () => {
            this._renderAILog();
            this.aiLogOverlayElement?.classList.remove('hidden');
        });
        const closeLog = () => this.aiLogOverlayElement?.classList.add('hidden');
        this.aiLogCloseElement?.addEventListener('click', closeLog);
        this.aiLogOverlayElement?.addEventListener('click', (e) => {
            if (e.target === this.aiLogOverlayElement) closeLog();
        });
        this.aiLogClearElement?.addEventListener('click', () => {
            this._aiLog = [];
            this._renderAILog();
        });

        this.aiGenerateElement?.addEventListener('click', () => this._aiGenerateAndFix());
        this.aiCancelElement?.addEventListener('click', () => {
            this._aiCanceled = true;
            this.ai.interrupt();
            this._appendAILog('info', 'Canceled by user.');
            this._setAIStatus('Canceling…');
        });
    }

    _aiSetBusy(busy) {
        this.aiGenerateElement?.classList.toggle('hidden', busy);
        this.aiCancelElement?.classList.toggle('hidden', !busy);
    }

    // Append a log entry and (if the dialog is open) re-render.
    _appendAILog(type, text) {
        this._aiLog.push({ ts: Date.now(), type, text });
        if (this.aiLogOverlayElement && !this.aiLogOverlayElement.classList.contains('hidden'))
            this._renderAILog();
    }

    _populateAIParams() {
        const model = QMLAI_MODELS.find(m => m.id === this.ai.modelId);
        if (this.aiParamsInfoElement) {
            this.aiParamsInfoElement.textContent =
                `Model: ${model?.label || this.ai.modelId}`;
        }
        if (this.aiParamsMaxTokensElement)
            this.aiParamsMaxTokensElement.value = String(QmlPlayground.getAIMaxTokens());
        if (this.aiParamsTemperatureElement)
            this.aiParamsTemperatureElement.value = String(QmlPlayground.getAITemperature());
        if (this.aiParamsMaxAttemptsElement)
            this.aiParamsMaxAttemptsElement.value = String(QmlPlayground.getAIMaxAttempts());
    }

    // ---- AI attempt tabs ----

    _resetAIAttempts() {
        this._aiAttempts = [];
        this._aiActiveAttempt = -1;
        this._renderAITabs();
    }

    _startAIAttempt(attemptNumber) {
        const idx = this._aiAttempts.length;
        this._aiAttempts.push({
            label: `Attempt ${attemptNumber}`,
            qml: '',
            status: 'pending',
        });
        // Auto-activate the FIRST attempt (so the user sees it stream
        // in). For subsequent (fix) attempts the user stays on whatever
        // tab they're already viewing.
        if (this._aiActiveAttempt < 0)
            this._aiActiveAttempt = idx;
        this._renderAITabs();
        return idx;
    }

    _appendToAIAttempt(idx, delta) {
        const att = this._aiAttempts[idx];
        if (!att) return;
        att.qml += delta;
        // Only mirror into the editor if the user is actually looking at
        // this attempt's tab; otherwise the attempt streams silently in
        // the background.
        if (this._aiActiveAttempt === idx) {
            this.editor?.appendValue(delta, { silent: true });
            this.project.setFileContent(
                this.activePath, this.editor?.getValue() ?? '');
        }
    }

    _finishAIAttempt(idx, qml, errors) {
        const att = this._aiAttempts[idx];
        if (!att) return;
        att.qml = qml;
        att.status = errors && errors.length > 0 ? 'fail' : 'ok';
        att.errorCount = errors?.length ?? 0;
        // If the active tab is this one, reconcile any cleanup differences
        // (e.g. fences stripped from the final result).
        if (this._aiActiveAttempt === idx) {
            const current = this.editor?.getValue() ?? '';
            if (current !== qml) this._setValue(qml);
            else this.project.setFileContent(this.activePath, qml);
        }
        this._renderAITabs();
    }

    _switchToAIAttempt(idx) {
        const att = this._aiAttempts[idx];
        if (!att) return;
        if (this._aiActiveAttempt === idx) return;
        // Save current editor content into the previously-active tab so
        // user edits aren't lost.
        if (this._aiActiveAttempt >= 0) {
            const cur = this._aiAttempts[this._aiActiveAttempt];
            if (cur) cur.qml = this.editor?.getValue() ?? cur.qml;
        }
        this._aiActiveAttempt = idx;
        this._setValue(att.qml);
        this._renderAITabs();
        // Selecting a tab makes that attempt live.
        if (this.runtime?.ready) this.run();
    }

    _renderAITabs() {
        if (!this.aiTabsElement) return;
        const visible = this._aiAttempts.length > 0;
        this.aiTabsElement.classList.toggle('hidden', !visible);
        this.aiTabsElement.innerHTML = '';
        if (!visible) return;
        this._aiAttempts.forEach((att, i) => {
            const tab = document.createElement('button');
            tab.className = 'ai-tab';
            tab.classList.add(`ai-tab-${att.status}`);
            if (i === this._aiActiveAttempt) tab.classList.add('active');
            const mark = att.status === 'ok'   ? ' ✓'
                       : att.truncated         ? ' …'
                       : att.status === 'fail' ? ` ✗${att.errorCount > 1 ? '×' + att.errorCount : ''}`
                       : '';
            tab.textContent = att.label + mark;
            if (att.truncated) tab.title = (tab.title ? tab.title + '\n' : '') + 'Output truncated (max_tokens)';
            tab.addEventListener('click', () => this._switchToAIAttempt(i));
            this.aiTabsElement.appendChild(tab);
        });
    }

    _renderAILog() {
        if (!this.aiLogBodyElement) return;
        this.aiLogBodyElement.innerHTML = '';
        if (this._aiLog.length === 0) {
            this.aiLogBodyElement.textContent = '(empty)';
            return;
        }
        for (const entry of this._aiLog) {
            const wrap = document.createElement('div');
            wrap.className = `ai-log-entry ai-log-${entry.type}`;
            const meta = document.createElement('div');
            meta.className = 'ai-log-meta';
            const t = new Date(entry.ts);
            meta.textContent = `${t.toLocaleTimeString()}  •  ${entry.type}`;
            const txt = document.createElement('div');
            txt.className = 'ai-log-text';
            txt.textContent = entry.text;
            wrap.appendChild(meta);
            wrap.appendChild(txt);
            this.aiLogBodyElement.appendChild(wrap);
        }
        // Scroll to bottom
        this.aiLogBodyElement.scrollTop = this.aiLogBodyElement.scrollHeight;
    }

    // Orchestrate: stream tokens into the editor, run, check errors,
    // ask the model to emit a fix, run, repeat up to the configured max attempts.
    async _aiGenerateAndFix() {
        const prompt = this.aiPromptElement?.value.trim() || '';
        if (!prompt) {
            this._setAIStatus('Enter a prompt first.');
            return;
        }
        if (!await hasWebGPU()) {
            this._setAIStatus('WebGPU is not available in this browser.');
            return;
        }

        this._aiCanceled = false;
        this._aiSetBusy(true);
        this._setAIProgress(null, 'Preparing…');

        // Reset to a fresh empty project so streaming has a single file to
        // write into.
        this._loadProjectObject({
            $schema: 'qmlplayground/project/v1',
            name: 'AI: ' + prompt.slice(0, 60),
            entry: 'Main.qml',
            files: [{ path: 'Main.qml', encoding: 'utf-8', content: '' }],
        });

        this._appendAILog('prompt', prompt);
        this._resetAIAttempts();
        this.ai.startSession(prompt);
        this._appendAILog('directive', `[system prompt]\n${this.ai.getSystemPrompt()}`);

        try {
            const ok = await this._aiRunSessionLoop(1);
            if (this._aiCanceled)
                this._setAIProgress(null, 'Canceled.');
            else
                this._setAIProgress(null, ok ? 'Done' : 'Done (with unresolved errors)');
        } catch (e) {
            this._setAIProgress(null, 'Error: ' + e.message);
            this._appendAILog('errors', e.message);
            this.log(`AI generate error: ${e.message}`, 'error');
        } finally {
            this._aiSetBusy(false);
        }
    }

    async _aiRunSessionLoop(attempt) {
        if (this._aiCanceled) return false;

        const isFix = attempt > 1;
        const maxAttempts = QmlPlayground.getAIMaxAttempts();
        this._setAIStatus(
            isFix ? `Fixing errors (attempt ${attempt}/${maxAttempts})…`
                  : 'Generating…');

        // Bump temperature on retries so the sampler can diverge from a
        // stuck answer.
        const baseTemp = QmlPlayground.getAITemperature();
        const temperature = Math.min(baseTemp + (attempt - 1) * 0.2, 2);
        const maxTokens = QmlPlayground.getAIMaxTokens();

        // Create a tab for this attempt. For the FIRST attempt the user
        // is moved to its tab (and the editor cleared so streaming
        // appears live). For fix attempts, the user stays on whatever
        // tab they're viewing — the new tab streams in the background.
        const attemptIdx = this._startAIAttempt(attempt);
        if (this._aiActiveAttempt === attemptIdx)
            this._setValue('');

        const { qml: result, finishReason } = await this.ai.runSession({
            onLoadProgress: ({ progress, text }) => {
                this._setAIProgress(progress, text);
            },
            onToken: (delta) => {
                this._appendToAIAttempt(attemptIdx, delta);
            },
            temperature,
            maxTokens,
        });
        this._setAIProgress(null, '');

        if (this._aiCanceled) return false;

        this._appendAILog('response', result);
        const newQml = result;

        if (finishReason === 'length') {
            this._appendAILog('info',
                `Attempt ${attempt}: output truncated — model hit max_tokens. ` +
                `Try a smaller prompt or a larger model (longer context).`);
            this._setAIStatus('Output truncated — try a smaller prompt or larger model.');
            // Mark the tab; treat truncation as a terminal failure for
            // this run (retrying will hit the same wall).
            const att = this._aiAttempts[attemptIdx];
            if (att) {
                att.qml = newQml;
                att.status = 'fail';
                att.errorCount = 0;
                att.truncated = true;
                this._renderAITabs();
            }
            return false;
        }

        // Run THIS attempt's QML to evaluate it — even if the user is
        // looking at a different tab. The runtime preview will show the
        // attempt being checked; user can click the tab to inspect.
        const errors = await this._runAndAwaitErrorsForQml(newQml);
        if (this._aiCanceled) return false;

        // Mark the tab with the outcome.
        this._finishAIAttempt(attemptIdx, newQml, errors);

        if (errors.length === 0) {
            this._appendAILog('info', `Attempt ${attempt}: success, no errors.`);
            return true;
        }

        const errorSummary = errors.map(e =>
            `line ${e.line}, col ${e.column}: ${e.message}`).join('\n');
        this._appendAILog('errors',
            `Attempt ${attempt} produced ${errors.length} error(s):\n${errorSummary}`);

        if (attempt >= maxAttempts) {
            this._appendAILog('info', `Reached max attempts (${maxAttempts}); giving up.`);
            return false;
        }

        this.ai.addFixTurn(newQml, errors);
        const msgs = this.ai.getMessages();
        const fixTurn = msgs[msgs.length - 1];
        if (fixTurn?.role === 'user')
            this._appendAILog('directive', `[fix turn ${attempt}→${attempt + 1}]\n${fixTurn.content}`);
        return this._aiRunSessionLoop(attempt + 1);
    }

    // Run an arbitrary QML string (bypassing the editor/project mirror)
    // and resolve with its error list. Used by the AI loop so a fix
    // attempt can be evaluated even when the user is viewing a
    // different tab.
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

    // Resolve with the error list reported after the next qmlloaded.
    _runAndAwaitErrors() {
        return new Promise((resolve) => {
            const handler = () => {
                this.runtime.removeEventListener('qmlloaded', handler);
                const issues = this.runtime.getErrors() || [];
                resolve(issues.filter(i => i.type === 'error' || !i.type));
            };
            this.runtime.addEventListener('qmlloaded', handler);
            this.run();
        });
    }

    _setAIStatus(msg) {
        if (this.aiStatusElement) this.aiStatusElement.textContent = msg;
    }

    _closeSuggestions() {
        this.aiSuggestionsOverlayElement?.classList.add('hidden');
    }

    _setAIProgress(progress, text) {
        if (this.aiStatusElement) this.aiStatusElement.textContent = text || '';
        if (!this.aiProgressElement || !this.aiProgressBarElement) return;
        if (progress == null) {
            this.aiProgressElement.classList.add('hidden');
            this.aiProgressBarElement.style.width = '0%';
        } else {
            this.aiProgressElement.classList.remove('hidden');
            this.aiProgressBarElement.style.width = (progress * 100).toFixed(1) + '%';
        }
    }

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
