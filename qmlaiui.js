// QmlAIUI — all UI for the AI mode feature: the editor-pane panel,
// the model selector with provider-aware optgroups, the attempts tab
// bar, the four side dialogs (Suggestions, System prompt, Params,
// Loop log), and the fix-loop orchestration. QmlAI does the actual
// inference; QmlAIUI drives the user-visible workflow around it.
//
// QmlPlayground constructs a QmlAIUI, hands it a host interface, and
// calls .mount() once the playground's own DOM exists. From then on
// the AI feature is self-contained except for a couple of
// playground-level hooks (settings toggles, project replacement,
// running a one-off QML string).

import {
    QMLAI_MODELS,
    QMLAI_DEFAULT_MODEL,
    OPENROUTER_MODELS,
    OPENROUTER_DEFAULT_MODEL,
    DEFAULT_SYSTEM_PROMPT,
    hasWebGPU,
} from './qmlai.js';

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

// Strip a leading / trailing markdown code fence if the model emitted
// one despite the system prompt forbidding them. Tolerant of partial
// fences so the streaming editor doesn't flicker.
function stripFencesProgressive(text) {
    let s = text;
    const leading = s.match(/^\s*```(?:qml|QML|qt)?\s*\n?/);
    if (leading) s = s.slice(leading[0].length);
    s = s.replace(/\n?```\s*$/, '');
    return s;
}

function _readNumber(key, fallback, { min, max } = {}) {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    if (min != null && n < min) return min;
    if (max != null && n > max) return max;
    return n;
}

// ---- Persistence helpers (exported for QmlPlayground to read/write) ----

export function getAILocalEnabled() {
    return localStorage.getItem('qmlplayground-ai-local-enabled') === 'true';
}

export function getAIOpenRouterEnabled() {
    return localStorage.getItem('qmlplayground-ai-openrouter-enabled') === 'true';
}

export function getAIModel() {
    return localStorage.getItem('qmlplayground-ai-model') || QMLAI_DEFAULT_MODEL;
}

export function getAIOpenRouterKey() {
    return localStorage.getItem('qmlplayground-ai-openrouter-key') || '';
}

export function getAISystemPrompt() {
    return localStorage.getItem('qmlplayground-ai-system-prompt') || DEFAULT_SYSTEM_PROMPT;
}

export function getAIMaxTokens() {
    return _readNumber('qmlplayground-ai-max-tokens', AI_DEFAULTS.maxTokens, { min: 64, max: 8192 });
}

export function getAITemperature() {
    return _readNumber('qmlplayground-ai-temperature', AI_DEFAULTS.temperature, { min: 0, max: 2 });
}

export function getAIMaxAttempts() {
    return _readNumber('qmlplayground-ai-max-attempts', AI_DEFAULTS.maxAttempts, { min: 1, max: 10 });
}

export function aiEnabled() {
    return getAILocalEnabled() || getAIOpenRouterEnabled();
}

export function providerForModelId(id) {
    if (QMLAI_MODELS.some(m => m.id === id)) return 'webllm';
    if (OPENROUTER_MODELS.some(m => m.id === id)) return 'openrouter';
    return id && id.includes('/') ? 'openrouter' : 'webllm';
}

// ---- Templates ----

const AI_BUTTON_HTML = `
    <button class="btn-ai hidden" title="Generate a QML project from a prompt">AI mode</button>
`;

const AI_PANEL_HTML = `
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
`;

const AI_OVERLAYS_HTML = `
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
                    <span class="ai-params-hint" style="flex:1">Changes apply immediately on next Generate.</span>
                </div>
            </div>
        </div>
    </div>
`;

const AI_STYLES = `
    .btn-ai {
        background: linear-gradient(135deg, #9aa0ff 0%, #5f73ff 100%) !important;
        color: white;
    }
    .btn-ai.hidden { display: none; }

    .ai-panel {
        background: var(--bg-secondary);
        border-bottom: 1px solid var(--border);
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex-shrink: 0;
    }
    .ai-panel.hidden { display: none; }

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
    .ai-prompt:focus { outline: none; border-color: var(--accent); }

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
    .btn-ai-log:hover { border-color: var(--accent); }

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
    .btn-ai-generate:hover { background: var(--accent-hover); }
    .btn-ai-generate.hidden { display: none; }
    .btn-ai-generate:disabled {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        cursor: wait;
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
    .btn-ai-cancel.hidden { display: none; }
    .btn-ai-cancel:hover { filter: brightness(1.1); }

    .ai-progress {
        height: 4px;
        background: var(--bg-tertiary);
        border-radius: 2px;
        overflow: hidden;
    }
    .ai-progress.hidden { display: none; }
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
    .ai-tabs.hidden { display: none; }
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
    .ai-tab:hover { border-color: var(--accent); }
    .ai-tab.active {
        background: var(--accent) !important;
        color: white;
        border-color: var(--accent);
    }
    .ai-tab.ai-tab-pending { font-style: italic; }
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
    .ai-suggestions-overlay.hidden { display: none; }

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
    .ai-samples button:hover { border-color: var(--accent); }

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
    .ai-params-overlay.hidden { display: none; }

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
    .ai-params-header span { flex: 1; }

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
    .btn-ai-systemprompt-save:hover { background: var(--accent-hover); }
    .btn-ai-systemprompt-reset {
        background: var(--bg-tertiary);
        color: var(--text-primary);
        border: 1px solid var(--border);
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
    .ai-params-row-input span { flex: 1; }
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
    .btn-ai-params-reset {
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
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
`;

// ---- QmlAIUI ----

export class QmlAIUI {
    /**
     * @param {ShadowRoot} shadow                 The component's shadow root.
     * @param {object} host
     * @param {object} host.ai                    QmlAI instance.
     * @param {object} host.editor                QmlEditor instance.
     * @param {function} host.replaceProject      (jsonObj) => void
     * @param {function} host.setEditorContent    (text) => void  (silent setValue + project sync)
     * @param {function} host.syncProjectFromEditor () => void  (project entry := editor.getValue())
     * @param {function} host.runQml              (qml) => Promise<errors[]>
     * @param {function} host.log                 (msg, type?) => void
     */
    constructor(shadow, host) {
        this.shadow = shadow;
        this.ai = host.ai;
        this.editor = host.editor;
        this.host = host;

        this._aiLog = [];
        this._aiAttempts = [];
        this._aiActiveAttempt = -1;
        this._aiCanceled = false;
    }

    // Inject DOM + CSS and wire all events. Must be called after the
    // playground's own DOM exists (so .toolbar-left, .editor-pane,
    // and the shadow root containers are reachable).
    mount() {
        // Styles
        const style = document.createElement('style');
        style.textContent = AI_STYLES;
        this.shadow.appendChild(style);

        // AI button at the end of the toolbar-left.
        const toolbarLeft = this.shadow.querySelector('.toolbar-left');
        if (toolbarLeft) toolbarLeft.insertAdjacentHTML('beforeend', AI_BUTTON_HTML);

        // AI panel + tabs at the top of the editor pane.
        const editorPane = this.shadow.querySelector('.editor-pane');
        if (editorPane) editorPane.insertAdjacentHTML('afterbegin', AI_PANEL_HTML);

        // Modal overlays at the end of the shadow root.
        this.shadow.firstElementChild?.insertAdjacentHTML('beforebegin', AI_OVERLAYS_HTML);

        this._queryElements();
        this._populateAIModelSelect();
        this._initAIDialog();
        this._applyAvailability();
    }

    _queryElements() {
        const $ = (sel) => this.shadow.querySelector(sel);
        this.aiButtonElement = $('.btn-ai');
        this.aiPanelElement = $('.ai-panel');
        this.aiTabsElement = $('.ai-tabs');
        this.aiModelElement = $('.ai-model');
        this.aiPromptElement = $('.ai-prompt');
        this.aiSamplesElement = $('.ai-samples');
        this.aiStatusElement = $('.ai-status');
        this.aiProgressElement = $('.ai-progress');
        this.aiProgressBarElement = $('.ai-progress-bar');
        this.aiGenerateElement = $('.btn-ai-generate');
        this.aiCancelElement = $('.btn-ai-cancel');
        this.aiSuggestionsButtonElement = $('.btn-ai-suggestions');
        this.aiSuggestionsOverlayElement = $('.ai-suggestions-overlay');
        this.aiSuggestionsCloseElement = $('.btn-ai-suggestions-close');
        this.aiSystemPromptButtonElement = $('.btn-ai-systemprompt');
        this.aiSystemPromptOverlayElement = $('.ai-systemprompt-overlay');
        this.aiSystemPromptCloseElement = $('.btn-ai-systemprompt-close');
        this.aiSystemPromptTextElement = $('.ai-systemprompt-text');
        this.aiSystemPromptSaveElement = $('.btn-ai-systemprompt-save');
        this.aiSystemPromptResetElement = $('.btn-ai-systemprompt-reset');
        this.aiLogButtonElement = $('.btn-ai-log');
        this.aiLogOverlayElement = $('.ai-log-overlay');
        this.aiLogCloseElement = $('.btn-ai-log-close');
        this.aiLogClearElement = $('.btn-ai-log-clear');
        this.aiLogBodyElement = $('.ai-log-body');
        this.aiParamsButtonElement = $('.btn-ai-params');
        this.aiParamsOverlayElement = $('.ai-params-overlay');
        this.aiParamsCloseElement = $('.btn-ai-params-close');
        this.aiParamsInfoElement = $('.ai-params-info');
        this.aiParamsMaxTokensElement = $('.ai-params-maxtokens');
        this.aiParamsTemperatureElement = $('.ai-params-temperature');
        this.aiParamsMaxAttemptsElement = $('.ai-params-maxattempts');
        this.aiParamsResetElement = $('.btn-ai-params-reset');
    }

    // ---- Public API ----

    // Apply availability based on whether at least one provider is on.
    _applyAvailability() {
        const on = aiEnabled();
        this.aiButtonElement?.classList.toggle('hidden', !on);
        if (!on) this.aiPanelElement?.classList.add('hidden');
    }

    // Playground calls this after the user toggles a provider in
    // Settings; we refresh button visibility AND the model selector.
    refresh() {
        this._applyAvailability();
        this._populateAIModelSelect();
    }

    // ---- Model selector ----

    _populateAIModelSelect() {
        if (!this.aiModelElement) return;
        const localOn = getAILocalEnabled();
        const orOn = getAIOpenRouterEnabled();
        const saved = getAIModel();

        this.aiModelElement.innerHTML = '';
        const addGroup = (label, models) => {
            const group = document.createElement('optgroup');
            group.label = label;
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = m.label;
                group.appendChild(opt);
            }
            this.aiModelElement.appendChild(group);
        };

        if (localOn) addGroup('Local (WebLLM)', QMLAI_MODELS);
        if (orOn) {
            const open = OPENROUTER_MODELS.filter(m => m.group === 'open');
            const frontier = OPENROUTER_MODELS.filter(m => m.group === 'frontier');
            if (open.length) addGroup('OpenRouter — open weights', open);
            if (frontier.length) addGroup('OpenRouter — frontier', frontier);
        }

        const allIds = [
            ...(localOn ? QMLAI_MODELS.map(m => m.id) : []),
            ...(orOn ? OPENROUTER_MODELS.map(m => m.id) : []),
        ];
        const target = allIds.includes(saved) ? saved : allIds[0];
        if (target) {
            this.aiModelElement.value = target;
            this._applySelectedAIModel(target);
        } else {
            this.ai.setProvider('webllm');
        }
    }

    _applySelectedAIModel(id) {
        const provider = providerForModelId(id);
        this.ai.setProvider(provider);
        if (provider === 'openrouter') this.ai.setOpenRouterModel(id);
        else this.ai.setModel(id);
        localStorage.setItem('qmlplayground-ai-model', id);
    }

    // ---- Wiring ----

    _initAIDialog() {
        if (!this.aiButtonElement || !this.aiPanelElement) return;

        // Model select
        this.aiModelElement?.addEventListener('change', (e) => {
            this._applySelectedAIModel(e.target.value);
            const prov = providerForModelId(e.target.value);
            this._setStatus(prov === 'webllm'
                ? 'Model will load on next Generate.' : '');
        });

        // Suggestions popover
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

        this.aiButtonElement.addEventListener('click', () => {
            const hidden = this.aiPanelElement.classList.toggle('hidden');
            if (!hidden) {
                this.aiPromptElement?.focus();
                this.editor?.refresh();
            }
        });

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
        const persistNumber = (el, key) => {
            if (!el) return;
            el.addEventListener('input', () => {
                const n = Number(el.value);
                if (Number.isFinite(n)) localStorage.setItem(key, String(n));
            });
        };
        persistNumber(this.aiParamsMaxTokensElement,   'qmlplayground-ai-max-tokens');
        persistNumber(this.aiParamsTemperatureElement, 'qmlplayground-ai-temperature');
        persistNumber(this.aiParamsMaxAttemptsElement, 'qmlplayground-ai-max-attempts');
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

        // Generate / cancel
        this.aiGenerateElement?.addEventListener('click', () => this._aiGenerateAndFix());
        this.aiCancelElement?.addEventListener('click', () => {
            this._aiCanceled = true;
            this.ai.interrupt();
            this._appendAILog('info', 'Canceled by user.');
            this._setStatus('Canceling…');
        });
    }

    _setBusy(busy) {
        this.aiGenerateElement?.classList.toggle('hidden', busy);
        this.aiCancelElement?.classList.toggle('hidden', !busy);
    }

    _setStatus(msg) {
        if (this.aiStatusElement) this.aiStatusElement.textContent = msg;
    }

    _setProgress(progress, text) {
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

    _closeSuggestions() {
        this.aiSuggestionsOverlayElement?.classList.add('hidden');
    }

    _populateAIParams() {
        if (this.aiParamsInfoElement) {
            const id = this.ai.activeModelId();
            const provider = providerForModelId(id);
            const list = provider === 'openrouter' ? OPENROUTER_MODELS : QMLAI_MODELS;
            const m = list.find(x => x.id === id);
            const providerLabel = provider === 'openrouter' ? 'OpenRouter' : 'WebLLM';
            this.aiParamsInfoElement.textContent = `${providerLabel} — ${m?.label || id}`;
        }
        if (this.aiParamsMaxTokensElement)
            this.aiParamsMaxTokensElement.value = String(getAIMaxTokens());
        if (this.aiParamsTemperatureElement)
            this.aiParamsTemperatureElement.value = String(getAITemperature());
        if (this.aiParamsMaxAttemptsElement)
            this.aiParamsMaxAttemptsElement.value = String(getAIMaxAttempts());
    }

    // ---- Loop log ----

    _appendAILog(type, text) {
        this._aiLog.push({ ts: Date.now(), type, text });
        if (this.aiLogOverlayElement && !this.aiLogOverlayElement.classList.contains('hidden'))
            this._renderAILog();
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
        this.aiLogBodyElement.scrollTop = this.aiLogBodyElement.scrollHeight;
    }

    // ---- Attempt tabs ----

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
        if (this._aiActiveAttempt < 0) this._aiActiveAttempt = idx;
        this._renderAITabs();
        return idx;
    }

    _appendToAIAttempt(idx, delta) {
        const att = this._aiAttempts[idx];
        if (!att) return;
        att.qml += delta;
        if (this._aiActiveAttempt === idx) {
            this.editor?.appendValue(delta, { silent: true });
            this.host.syncProjectFromEditor();
        }
    }

    _finishAIAttempt(idx, qml, errors) {
        const att = this._aiAttempts[idx];
        if (!att) return;
        att.qml = qml;
        att.status = errors && errors.length > 0 ? 'fail' : 'ok';
        att.errorCount = errors?.length ?? 0;
        if (this._aiActiveAttempt === idx) {
            const current = this.editor?.getValue() ?? '';
            if (current !== qml) this.host.setEditorContent(qml);
            else this.host.syncProjectFromEditor();
        }
        this._renderAITabs();
    }

    _switchToAIAttempt(idx) {
        const att = this._aiAttempts[idx];
        if (!att) return;
        if (this._aiActiveAttempt === idx) return;
        if (this._aiActiveAttempt >= 0) {
            const cur = this._aiAttempts[this._aiActiveAttempt];
            if (cur) cur.qml = this.editor?.getValue() ?? cur.qml;
        }
        this._aiActiveAttempt = idx;
        this.host.setEditorContent(att.qml);
        this._renderAITabs();
        // Run the selected tab so the preview reflects it.
        this.host.runQml(att.qml);
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
            if (att.truncated) tab.title = 'Output truncated (max_tokens)';
            tab.addEventListener('click', () => this._switchToAIAttempt(i));
            this.aiTabsElement.appendChild(tab);
        });
    }

    // ---- Loop orchestration ----

    async _aiGenerateAndFix() {
        const prompt = this.aiPromptElement?.value.trim() || '';
        if (!prompt) {
            this._setStatus('Enter a prompt first.');
            return;
        }
        // WebGPU is required for the local provider; OpenRouter doesn't need it.
        const provider = providerForModelId(this.ai.activeModelId());
        if (provider === 'webllm' && !await hasWebGPU()) {
            this._setStatus('WebGPU is not available in this browser.');
            return;
        }

        this._aiCanceled = false;
        this._setBusy(true);
        this._setProgress(null, 'Preparing…');

        // Fresh empty project for this run.
        this.host.replaceProject({
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
            if (this._aiCanceled) this._setProgress(null, 'Canceled.');
            else this._setProgress(null, ok ? 'Done' : 'Done (with unresolved errors)');
        } catch (e) {
            this._setProgress(null, 'Error: ' + e.message);
            this._appendAILog('errors', e.message);
            this.host.log(`AI generate error: ${e.message}`, 'error');
        } finally {
            this._setBusy(false);
        }
    }

    async _aiRunSessionLoop(attempt) {
        if (this._aiCanceled) return false;

        const isFix = attempt > 1;
        const maxAttempts = getAIMaxAttempts();
        this._setStatus(
            isFix ? `Fixing errors (attempt ${attempt}/${maxAttempts})…`
                  : 'Generating…');

        const baseTemp = getAITemperature();
        const temperature = Math.min(baseTemp + (attempt - 1) * 0.2, 2);
        const maxTokens = getAIMaxTokens();

        // First attempt is active by default; fix attempts stream to
        // their own tab without changing what the user is viewing.
        const attemptIdx = this._startAIAttempt(attempt);
        if (this._aiActiveAttempt === attemptIdx)
            this.host.setEditorContent('');

        const { qml: result, finishReason } = await this.ai.runSession({
            onLoadProgress: ({ progress, text }) => this._setProgress(progress, text),
            onToken: (delta) => this._appendToAIAttempt(attemptIdx, delta),
            temperature,
            maxTokens,
        });
        this._setProgress(null, '');

        if (this._aiCanceled) return false;

        this._appendAILog('response', result);
        const newQml = result;

        if (finishReason === 'length') {
            this._appendAILog('info',
                `Attempt ${attempt}: output truncated — model hit max_tokens. ` +
                `Try a smaller prompt or a larger model (longer context).`);
            this._setStatus('Output truncated — try a smaller prompt or larger model.');
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

        const errors = await this.host.runQml(newQml);
        if (this._aiCanceled) return false;

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
}
