// QmlAI — client-side AI assistant that generates QML projects from a
// natural-language prompt. Wraps WebLLM (https://webllm.mlc.ai) running
// on WebGPU. All inference is fully in-browser; no API key, no network
// calls during generation.
//
// The WebLLM module is loaded from a CDN on first use so the playground
// stays a small static download for users who don't opt in.

const WEBLLM_MODULE_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.83';

// Curated subset of WebLLM's prebuilt models. Sizes are vram_required_MB
// from WebLLM's src/config.ts. download size is similar.
export const QMLAI_MODELS = [
    {
        id: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
        label: 'SmolLM2 360M (~380 MB)',
        sizeMB: 376,
    },
    {
        id: 'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC',
        label: 'Qwen2.5 Coder 0.5B (~950 MB)',
        sizeMB: 945,
    },
    {
        id: 'Qwen3.5-0.8B-q4f16_1-MLC',
        label: 'Qwen 3.5 0.8B (~1.6 GB)',
        sizeMB: 1629,
    },
    {
        id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
        label: 'Qwen2.5 Coder 1.5B (~1.6 GB)',
        sizeMB: 1630,
        default: true,
    },
    {
        id: 'Qwen3.5-2B-q4f16_1-MLC',
        label: 'Qwen 3.5 2B (~2.2 GB)',
        sizeMB: 2245,
    },
    {
        id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
        label: 'Llama 3.2 3B (~2.3 GB)',
        sizeMB: 2264,
    },
    {
        id: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC',
        label: 'Qwen2.5 Coder 3B (~2.5 GB)',
        sizeMB: 2505,
    },
];

export const QMLAI_DEFAULT_MODEL =
    QMLAI_MODELS.find(m => m.default)?.id ?? QMLAI_MODELS[0].id;

// Curated OpenRouter model list. Two implicit sub-groups: "Open
// weights" (gpt-oss, qwen3) and "Frontier" (Claude/GPT-5/Gemini).
// The selector groups them with <optgroup>.
export const OPENROUTER_MODELS = [
    // Open weights
    { id: 'openai/gpt-oss-120b',   label: 'GPT-OSS 120B',         group: 'open' },
    { id: 'openai/gpt-oss-20b',    label: 'GPT-OSS 20B',          group: 'open' },
    { id: 'qwen/qwen3.6-35b-a3b',  label: 'Qwen3.6 35B-A3B (MoE)', group: 'open' },
    { id: 'qwen/qwen3-coder',      label: 'Qwen3 Coder',          group: 'open' },
    { id: 'qwen/qwen3-32b',        label: 'Qwen3 32B',            group: 'open' },
    // Frontier
    { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', group: 'frontier' },
    { id: 'anthropic/claude-opus-4.5',   label: 'Claude Opus 4.5',   group: 'frontier' },
    { id: 'openai/gpt-5',                label: 'GPT-5',             group: 'frontier' },
    { id: 'openai/gpt-5-mini',           label: 'GPT-5 mini',        group: 'frontier' },
    { id: 'google/gemini-2.5-pro',       label: 'Gemini 2.5 Pro',    group: 'frontier' },
];

export const OPENROUTER_DEFAULT_MODEL = OPENROUTER_MODELS[0].id;

export const DEFAULT_SYSTEM_PROMPT = `You are a QML code generator embedded in the QML Playground, a browser-based Qt for WebAssembly editor. Output ONE complete .qml document and NOTHING ELSE. No prose, no explanation, no markdown fences, no leading or trailing blank lines.

Rules:
1. The root item must fill its parent: use anchors.fill: parent on a Rectangle, Item, or appropriate root component.
2. Use only these imports, and only the ones you actually need:
       import QtQuick
       import QtQuick.Controls
       import QtQuick.Layouts
       import QtQuick.Particles
       import QtQuick.Shapes
       import QtQuick.Effects
       import QtQuick3D
       import QtGraphs
   Do not invent imports. Do not use version numbers.
3. Target Qt 6.11+ QML. Property names are case-sensitive: radius, color, width, onClicked (not onClick), anchors.centerIn.
4. Prefer declarative bindings. Use NumberAnimation / SequentialAnimation / Behavior for motion.
5. No external assets — no images, fonts, shaders, or qrc paths. Generate visuals from primitives, gradients, Shapes, or Quick3D meshes.
6. Keep it under ~80 lines unless the user asks for more.

If the request is impossible in QML or outside the allowed modules, output a minimal Rectangle with a Text child that explains the limitation.`;

const SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT;

const FEWSHOT_USER = 'A blue rounded rectangle that rotates continuously, centered.';
const FEWSHOT_ASSISTANT = `import QtQuick

Rectangle {
    anchors.fill: parent
    color: "#1e1e1e"

    Rectangle {
        width: 120; height: 120
        anchors.centerIn: parent
        color: "#0e639c"
        radius: 12

        RotationAnimation on rotation {
            from: 0; to: 360
            duration: 3000
            loops: Animation.Infinite
        }
    }
}`;

export async function hasWebGPU() {
    if (!('gpu' in navigator)) return false;
    try {
        const adapter = await navigator.gpu.requestAdapter();
        return !!adapter;
    } catch (_) {
        return false;
    }
}

class QmlAI extends EventTarget {
    constructor(options = {}) {
        super();
        this.provider = options.provider ?? 'webllm'; // 'webllm' | 'openrouter'
        this.modelId = options.modelId ?? QMLAI_DEFAULT_MODEL;
        this.openrouterKey = options.openrouterKey ?? '';
        this.openrouterModel = options.openrouterModel ?? OPENROUTER_DEFAULT_MODEL;
        this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
        this._engine = null;
        this._loadedModelId = null;
        this._loading = false;
        this._webllm = null;
        this._messages = null; // current session's message history
        this._initialPrompt = null;
        this._abortCtrl = null; // active fetch AbortController for OpenRouter
    }

    setProvider(p) { this.provider = p; }
    setOpenRouterKey(k) { this.openrouterKey = k || ''; }
    setOpenRouterModel(m) { this.openrouterModel = m || OPENROUTER_DEFAULT_MODEL; }

    // Active model id depending on provider.
    activeModelId() {
        return this.provider === 'openrouter' ? this.openrouterModel : this.modelId;
    }

    setSystemPrompt(text) {
        this.systemPrompt = text || DEFAULT_SYSTEM_PROMPT;
    }

    getSystemPrompt() {
        return this.systemPrompt;
    }

    isReady() {
        if (this.provider === 'openrouter') return !!this.openrouterKey;
        return !!this._engine && this._loadedModelId === this.modelId;
    }

    setModel(modelId) {
        this.modelId = modelId;
    }

    async _ensureWebLLM() {
        if (this._webllm) return this._webllm;
        this._webllm = await import(/* @vite-ignore */ WEBLLM_MODULE_URL);
        return this._webllm;
    }

    // Load (or switch to) the configured model. onProgress receives
    // { progress: 0..1, text: string } reports from WebLLM.
    async loadModel(onProgress) {
        if (this.isReady()) return;
        if (this._loading) return;
        this._loading = true;
        try {
            const webllm = await this._ensureWebLLM();
            if (this._engine && this._loadedModelId !== this.modelId) {
                try { await this._engine.unload(); } catch (_) { /* ignore */ }
                this._engine = null;
            }
            this._engine = await webllm.CreateMLCEngine(this.modelId, {
                initProgressCallback: (report) => {
                    onProgress?.({ progress: report.progress, text: report.text });
                },
            });
            this._loadedModelId = this.modelId;
            try { navigator.storage?.persist?.(); } catch (_) { /* ignore */ }
        } finally {
            this._loading = false;
        }
    }

    // Start a fresh session with the user's prompt. Sets up the
    // system + few-shot + user-prompt message stack and forgets any
    // previous session.
    startSession(prompt) {
        this._initialPrompt = prompt;
        this._messages = [
            { role: 'system', content: this.systemPrompt },
            { role: 'user',   content: FEWSHOT_USER },
            { role: 'assistant', content: FEWSHOT_ASSISTANT },
            { role: 'user',   content: prompt },
        ];
    }

    // Snapshot the current session's message history (for the loop log).
    getMessages() {
        return this._messages ? this._messages.slice() : [];
    }

    // Append a fix-turn that asks the model to produce a fresh, full
    // corrected QML document. Small models didn't reliably follow
    // patch / diff / sed formats; a full rewrite is the format every
    // model is already practiced at.
    addFixTurn(currentQml, errors) {
        if (!this._messages) throw new Error('No active AI session');

        // Don't repeat the QML — the previous assistant turn already
        // contains it, and quoting it again doubles token usage on
        // small-context models.
        const qmlLines = currentQml.split('\n');
        const items = errors.map(e => {
            const line = e.line > 0 && e.line <= qmlLines.length
                ? `    > ${qmlLines[e.line - 1]}`
                : '';
            const ident = (e.message.match(/"([^"]+)"/) || [])[1];
            const hint = ident
                ? ` (do not use \`${ident}\`)`
                : '';
            return `- line ${e.line}, column ${e.column}: ${e.message}${hint}\n${line}`;
        }).join('\n');

        this._messages.push({
            role: 'user',
            content:
`The QML you just produced fails to load with these errors:

${items}

Output a NEW, complete corrected .qml document. Take a different approach for the offending lines — do not include them again as-is. Output the full QML and nothing else: no prose, no markdown fences, no explanations.`
        });
    }

    // Stream the current session's next assistant turn. onToken is
    // called with each delta. Returns the full assistant text and
    // appends it to the message history so subsequent fix turns build
    // on this attempt.
    async runSession({ onToken, onLoadProgress, temperature = 0.2, maxTokens = 1024 } = {}) {
        if (!this._messages) throw new Error('No active AI session');

        if (this.provider === 'openrouter')
            return this._runOpenRouter({ onToken, temperature, maxTokens });

        if (!await hasWebGPU())
            throw new Error('WebGPU is not available in this browser');

        if (!this.isReady())
            await this.loadModel(onLoadProgress);

        const stream = await this._engine.chat.completions.create({
            messages: this._messages,
            stream: true,
            temperature,
            max_tokens: maxTokens,
        });

        // Models like Qwen3 emit <think>…</think> reasoning before the
        // answer. Strip those blocks so they never reach the editor and
        // never end up in the QML we hand to the runtime. The trailing
        // buffer holds incomplete <think> tag prefixes so we don't
        // emit a `<` that will turn out to be the start of a `<think>`.
        let raw = '';
        let emittedLen = 0;
        let finishReason = null;
        for await (const chunk of stream) {
            const choice = chunk.choices?.[0];
            const delta = choice?.delta?.content ?? '';
            if (choice?.finish_reason)
                finishReason = choice.finish_reason;
            if (!delta) continue;
            raw += delta;

            const visible = stripThink(raw);
            const safeLen = safeEmittableLen(visible);
            if (safeLen > emittedLen) {
                const out = visible.slice(emittedLen, safeLen);
                emittedLen = safeLen;
                if (out) onToken?.(out);
            }
        }

        // Flush any remaining safely-emittable chars.
        const finalVisible = stripThink(raw);
        if (finalVisible.length > emittedLen) {
            const out = finalVisible.slice(emittedLen);
            if (out) onToken?.(out);
        }

        const qml = stripFences(finalVisible).trim();
        this._messages.push({ role: 'assistant', content: qml });
        return { qml, finishReason };
    }

    // Convenience: wrap the entry QML as a v1 project.
    wrapAsProject(qml, promptForName) {
        const title = (promptForName ?? this._initialPrompt ?? '').trim().slice(0, 60);
        return {
            $schema: 'qmlplayground/project/v1',
            id: 'ai-generated-' + Date.now(),
            name: 'AI: ' + (title || 'untitled'),
            entry: 'Main.qml',
            qtModules: [],
            files: [
                { path: 'Main.qml', encoding: 'utf-8', content: qml + '\n' },
            ],
        };
    }

    endSession() {
        this._messages = null;
        this._initialPrompt = null;
    }

    // Cancel an in-flight generation (works for either provider).
    interrupt() {
        try { this._abortCtrl?.abort(); } catch (_) { /* ignore */ }
        try { this._engine?.interruptGenerate(); } catch (_) { /* ignore */ }
    }

    // Stream from OpenRouter's chat completions endpoint via SSE.
    async _runOpenRouter({ onToken, temperature, maxTokens }) {
        if (!this.openrouterKey)
            throw new Error('OpenRouter API key not set — open Params to add one.');

        const ctrl = new AbortController();
        this._abortCtrl = ctrl;

        let response;
        try {
            response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                signal: ctrl.signal,
                headers: {
                    'Authorization': `Bearer ${this.openrouterKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': window.location.origin || 'https://msorvig.github.io/qmlplayground',
                    'X-Title': 'QML Playground',
                },
                body: JSON.stringify({
                    model: this.openrouterModel,
                    messages: this._messages,
                    stream: true,
                    temperature,
                    max_tokens: maxTokens,
                }),
            });
        } catch (e) {
            this._abortCtrl = null;
            if (e.name === 'AbortError') return { qml: '', finishReason: 'cancel' };
            throw e;
        }

        if (!response.ok) {
            this._abortCtrl = null;
            const text = await response.text().catch(() => '');
            throw new Error(`OpenRouter ${response.status}: ${text || response.statusText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let raw = '';
        let emittedLen = 0;
        let finishReason = null;

        try {
            outer: while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });

                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line || !line.startsWith('data:')) continue;
                    const payload = line.slice(5).trim();
                    if (payload === '[DONE]') break outer;
                    let obj;
                    try { obj = JSON.parse(payload); } catch (_) { continue; }
                    const choice = obj.choices?.[0];
                    if (choice?.finish_reason) finishReason = choice.finish_reason;
                    const delta = choice?.delta?.content ?? '';
                    if (!delta) continue;
                    raw += delta;
                    const visible = stripThink(raw);
                    const safeLen = safeEmittableLen(visible);
                    if (safeLen > emittedLen) {
                        const out = visible.slice(emittedLen, safeLen);
                        emittedLen = safeLen;
                        if (out) onToken?.(out);
                    }
                }
            }
        } catch (e) {
            this._abortCtrl = null;
            if (e.name === 'AbortError') {
                const partial = stripFences(stripThink(raw)).trim();
                if (partial) this._messages.push({ role: 'assistant', content: partial });
                return { qml: partial, finishReason: 'cancel' };
            }
            throw e;
        }
        this._abortCtrl = null;

        // Flush trailing visible chars.
        const finalVisible = stripThink(raw);
        if (finalVisible.length > emittedLen) {
            const out = finalVisible.slice(emittedLen);
            if (out) onToken?.(out);
        }

        const qml = stripFences(finalVisible).trim();
        this._messages.push({ role: 'assistant', content: qml });
        return { qml, finishReason };
    }
}

// Strip markdown code fences if the model emitted them despite the
// system prompt forbidding it.
function stripFences(text) {
    const fence = /^```(?:qml|QML|qt)?\s*\n([\s\S]*?)\n```\s*$/m;
    const m = text.match(fence);
    return m ? m[1] : text;
}

// Strip <think>…</think> reasoning blocks (Qwen3-style "thinking"
// preamble) from a buffer. Removes complete pairs; truncates at an
// unclosed `<think>` so partial reasoning never reaches the consumer.
function stripThink(text) {
    let s = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
    const open = s.lastIndexOf('<think>');
    if (open !== -1 && s.indexOf('</think>', open) === -1)
        s = s.slice(0, open);
    return s;
}

// Hold back the trailing characters of `text` that could be the start
// of a `<think>` tag. Returns the length safe to emit. Once the tag
// is either completed or proven not to be one, the held chars become
// emittable.
function safeEmittableLen(text) {
    const tag = '<think>';
    const maxHold = Math.min(tag.length - 1, text.length);
    for (let i = maxHold; i > 0; i--) {
        if (text.endsWith(tag.slice(0, i)))
            return text.length - i;
    }
    return text.length;
}

export { QmlAI };
