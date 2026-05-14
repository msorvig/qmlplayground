// QmlAI — client-side AI assistant that generates QML projects from a
// natural-language prompt. Wraps WebLLM (https://webllm.mlc.ai) running
// on WebGPU. All inference is fully in-browser; no API key, no network
// calls during generation.
//
// The WebLLM module is loaded from a CDN on first use so the playground
// stays a small static download for users who don't opt in.

const WEBLLM_MODULE_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.79';

// Curated subset of WebLLM's prebuilt models. Sizes are vram_required_MB
// from WebLLM's src/config.ts. download size is similar.
export const QMLAI_MODELS = [
    {
        id: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
        label: 'SmolLM2 360M (~380 MB) — tiny, fastest, weakest output',
        sizeMB: 376,
    },
    {
        id: 'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC',
        label: 'Qwen2.5 Coder 0.5B (~950 MB) — small coder',
        sizeMB: 945,
    },
    {
        id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
        label: 'Qwen2.5 Coder 1.5B (~1.6 GB) — recommended',
        sizeMB: 1630,
        default: true,
    },
    {
        id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
        label: 'Llama 3.2 3B (~2.3 GB) — bigger general model',
        sizeMB: 2264,
    },
    {
        id: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC',
        label: 'Qwen2.5 Coder 3B (~2.5 GB) — biggest coder',
        sizeMB: 2505,
    },
];

export const QMLAI_DEFAULT_MODEL =
    QMLAI_MODELS.find(m => m.default)?.id ?? QMLAI_MODELS[0].id;

const SYSTEM_PROMPT = `You are a QML code generator embedded in the QML Playground, a browser-based Qt for WebAssembly editor. Output ONE complete .qml document and NOTHING ELSE. No prose, no explanation, no markdown fences, no leading or trailing blank lines.

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
        this.modelId = options.modelId ?? QMLAI_DEFAULT_MODEL;
        this._engine = null;
        this._loadedModelId = null;
        this._loading = false;
        this._webllm = null;
    }

    isReady() {
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

    // Generate a project from a natural-language prompt. Streams tokens
    // via onToken. Returns a v1 QmlProject JSON object whose entry file
    // is the generated QML.
    async generate(prompt, { onToken, onLoadProgress } = {}) {
        if (!await hasWebGPU())
            throw new Error('WebGPU is not available in this browser');

        if (!this.isReady())
            await this.loadModel(onLoadProgress);

        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: FEWSHOT_USER },
            { role: 'assistant', content: FEWSHOT_ASSISTANT },
            { role: 'user',   content: prompt },
        ];

        const stream = await this._engine.chat.completions.create({
            messages,
            stream: true,
            temperature: 0.2,
            max_tokens: 1024,
        });

        let raw = '';
        for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta?.content ?? '';
            if (delta) {
                raw += delta;
                onToken?.(delta);
            }
        }

        const qml = stripFences(raw).trim();
        const title = prompt.trim().slice(0, 60);

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

    // Cancel an in-flight generation.
    interrupt() {
        try { this._engine?.interruptGenerate(); } catch (_) { /* ignore */ }
    }
}

// Strip markdown code fences if the model emitted them despite the
// system prompt forbidding it.
function stripFences(text) {
    const fence = /^```(?:qml|QML|qt)?\s*\n([\s\S]*?)\n```\s*$/m;
    const m = text.match(fence);
    return m ? m[1] : text;
}

export { QmlAI };
