// QmlComponentViewer - manages multiple QmlRuntime instances on a page,
// one per preview. Each preview is its own wasm instance, so per-preview
// Quick Controls style / scale / etc. work without runtime changes.
//
// An example's QML is authored in two parts: the *preamble* (imports, and
// anything else the runtime needs but a reader doesn't care about) and the
// *sample* (the snippet on show). The live preview runs `preamble + sample`;
// the optional editor displays only the sample.

import { QmlRuntime, QmlInstance } from './qmlruntime.js';
import { QmlEditor } from './qmleditor.js';
import { QmlProject } from './qmlproject.js';

// Assemble the QML actually handed to the runtime from its two parts.
function assembleQml(preamble, sample) {
    const pre = (preamble ?? '').trim();
    const body = sample ?? '';
    return pre ? `${pre}\n${body}` : body;
}

class Preview {
    constructor(viewer, id, container, runtime, editor = null) {
        this.viewer = viewer;
        this.id = id;
        this.container = container;
        this.runtime = runtime;
        // The snippet editor showing this preview's sample, if it has one.
        this.editor = editor;
        // The document as a one-file project. A file-backed document (rather
        // than a setData() string) is what lets the runtime hot reload it:
        // the service addresses documents by URL.
        this.project = new QmlProject({ entry: 'Main.qml', name: id });
    }

    // Load `source` as this preview's document. With hot reload available,
    // a changed document is patched in place; see QmlRuntime.loadProject().
    loadQml(source) {
        this.project.setEntryContent(source);
        this.runtime.loadProject(this.project);
    }

    getErrors() {
        return this.runtime.getErrors();
    }

    destroy() {
        this.runtime.destroy();
        this.editor?.destroy();
        this._surface?.remove();
        this.viewer._previews.delete(this.id);
    }

    on(event, cb) {
        this.runtime.on(event, cb);
        return this;
    }
}

class QmlComponentViewer {
    constructor(config = {}) {
        const { mode = 'static', preamble = '', style = '',
                instancing = 'isolated', colorScheme = 'light',
                hotReload = true } = config;
        this.mode = mode;
        this._basePath = mode === 'shared' ? 'shared' : 'static';
        // Hot reload: edits to a sample patch its running preview in place
        // instead of recreating it, so a slider keeps its value while its code
        // is being edited. Needs the QmlPreview service in the runtime, which
        // is started per wasm instance; each preview's runtime uses it.
        this.hotReload = hotReload;
        // 'isolated' (default): one wasm instance per preview — each can have
        // its own Controls style. 'shared': one wasm instance hosting all the
        // previews (lighter; one style for the whole page).
        this.instancing = instancing;
        // Color scheme for the whole page: 'light' | 'dark' | 'auto'. Forces
        // the Qt previews' scheme and drives the editor theme.
        this.colorScheme = colorScheme;
        this._sharedInstance = null;
        // Shared preamble (imports) prepended to every sample on this page.
        // The page knows which components its samples use, so it configures
        // the imports here once rather than repeating them per example.
        this.preamble = preamble;
        // Quick Controls style applied to every preview (''/'Default' = the
        // build's default). QQuickStyle is read once per wasm instance, so
        // changing it relaunches each preview (see setStyle).
        this.style = style;
        this._previews = new Map();
        this._nextId = 0;
        this._modulePromise = null;
    }

    // Environment passed to each runtime — carries the global Controls style.
    _environment() {
        const env = {};
        if (this.style && this.style !== 'Default')
            env.QT_QUICK_CONTROLS_STYLE = this.style;
        return env;
    }

    // Fetch + compile the runtime wasm exactly once, lazily on first use.
    // Every preview instantiates from this single compiled module, so the
    // (expensive) compile of the ~44 MB static binary happens one time
    // regardless of how many previews are on the page.
    _compileModule() {
        if (!this._modulePromise) {
            const url = new URL(`./${this._basePath}/qmlruntime_wasm.wasm`,
                                import.meta.url);
            this._modulePromise = WebAssembly.compileStreaming(fetch(url))
                .catch(async (e) => {
                    // Falls back when the server doesn't send
                    // Content-Type: application/wasm (required by streaming).
                    const bytes = await (await fetch(url)).arrayBuffer();
                    return WebAssembly.compile(bytes);
                });
        }
        return this._modulePromise;
    }

    // Build the QmlRuntime (view) for a container, per the instancing mode.
    // Isolated views each own an instance (sharing the compiled module);
    // shared views all borrow one lazily-created instance.
    _runtimeFor(container) {
        if (this.instancing === 'shared') {
            if (!this._sharedInstance) {
                this._sharedInstance = new QmlInstance({
                    mode: this.mode,
                    module: this._compileModule(),
                    environment: this._environment(),
                    colorScheme: this.colorScheme,
                    hotReload: this.hotReload,
                });
            }
            return new QmlRuntime(container, { instance: this._sharedInstance,
                                               hotReload: this.hotReload });
        }
        return new QmlRuntime(container, {
            mode: this.mode,
            module: this._compileModule(),
            environment: this._environment(),
            colorScheme: this.colorScheme,
            hotReload: this.hotReload,
        });
    }

    // Create a preview in `container`. The QML to run is either `qml`
    // verbatim, or `preamble + sample` assembled. If `codeHost` is given, a
    // snippet-mode QmlEditor showing just `sample` is created in it. Returns
    // once the wasm is ready and the QML has been handed to the runtime.
    async addPreview(container, options = {}) {
        const {
            qml,
            preamble = this.preamble,
            sample = '',
            codeHost = null,
            // How the control is sized in the preview: 'none' keeps its
            // implicit size and centers it (good for most controls), 'width' /
            // 'height' fill that axis, 'both' fills the box (e.g. TextArea).
            fill = 'none',
            id = `preview-${this._nextId++}`,
        } = options;

        const fillWidth = fill === 'width' || fill === 'both';
        const fillHeight = fill === 'height' || fill === 'both';

        // Show the sample (imports hidden) while the wasm loads. The editor
        // is editable; edits re-run the preview.
        // The code editor always stays light; only the Qt preview follows the
        // color scheme.
        let editor = null;
        if (codeHost) {
            editor = new QmlEditor(codeHost, { mode: 'snippet', source: sample });
            await editor.init();
        }

        // Qt sizes its screen to the element it's given, so render into an
        // inset child: that leaves a real gap around the content (padding the
        // container instead only offsets it, which clips on overflow).
        const surface = document.createElement('div');
        Object.assign(surface.style, { position: 'absolute', inset: '5px' });
        container.appendChild(surface);

        const runtime = this._runtimeFor(surface);
        const preview = new Preview(this, id, container, runtime, editor);
        preview._surface = surface;
        // Remember how to rebuild this preview (e.g. on a style change).
        preview._spec = { container, codeHost, preamble, qml, sample, fill };
        this._previews.set(id, preview);

        await runtime.load();

        // Qt numbers errors against the assembled `preamble + sample`, but the
        // viewer shows only the sample — subtract the hidden preamble lines so
        // markers land on the right editor line.
        const pre = (preamble ?? '').trim();
        const preambleLines = pre ? pre.split('\n').length : 0;

        // (Re)assemble from the current editor contents and load it. The
        // first run is a full load; later ones are patched in place when hot
        // reload is available (the runtime falls back to a full load itself).
        const run = () => {
            const body = editor ? editor.getValue() : sample;
            const src = qml ?? assembleQml(preamble, body);
            editor?.clearMarkers();
            if (!src) return;
            try {
                runtime.setSizeMode(fillWidth, fillHeight);
                preview.loadQml(src);
            } catch (e) {
                editor?.addMarker(1, 0, e.message, 'error');
            }
        };

        if (editor) {
            // After each load, mirror the runtime's errors/warnings into the
            // editor (line tint + hover tooltip), mapped back to editor lines.
            runtime.on('qmlloaded', () => {
                editor.clearMarkers();
                for (const issue of runtime.getErrors() || []) {
                    editor.addMarker((issue.line ?? 0) - preambleLines,
                                     issue.column ?? 0,
                                     issue.message ?? '',
                                     issue.type || 'error');
                }
            });

            let timer = null;
            editor.on('change', () => {
                clearTimeout(timer);
                timer = setTimeout(run, 200);
            });
        }

        run();   // initial render

        return preview;
    }

    removePreview(id) {
        const p = this._previews.get(id);
        if (p) p.destroy();
    }

    // Change the color scheme live ('light' | 'dark' | 'auto'). Applies only
    // to the Qt previews (process-global, live-settable, no reload); the code
    // editors stay light.
    setColorScheme(scheme) {
        this.colorScheme = scheme;
        // Shared instance (if any) plus every live view's instance.
        this._sharedInstance?.setColorScheme(scheme);
        for (const p of this.previews())
            p.runtime.setColorScheme(scheme);
    }

    previews() {
        return Array.from(this._previews.values());
    }

    // Change the global Quick Controls style. QQuickStyle is read once per
    // wasm instance, so this relaunches every preview — re-instantiating from
    // the already-compiled module (no recompile). Any edits in the code
    // viewers are preserved. Returns when all previews are back.
    async setStyle(style) {
        if (style === this.style) return;
        this.style = style;

        // Capture each preview's current state (edited sample included) in
        // DOM order, then tear them all down and rebuild with the new style.
        const specs = this.previews().map(p => ({
            ...p._spec,
            sample: p.editor ? p.editor.getValue() : p._spec.sample,
        }));
        for (const p of this.previews()) p.destroy();

        // The style lives in the wasm environment, baked in at load. In shared
        // mode that's the single instance, so drop it — the next addPreview
        // recreates it (reusing the compiled module) with the new style.
        if (this._sharedInstance) {
            this._sharedInstance.destroy();
            this._sharedInstance = null;
        }

        for (const spec of specs)
            await this.addPreview(spec.container, spec);
    }

    // Scan `root` for `.example` blocks and instantiate each. An example
    // contains a `.code` host whose text *is* the sample (authored on the
    // page) and a `.preview` host for the live runtime. The sample is shown
    // in an editor in the `.code` host and run as `preamble + sample`.
    // `options` may carry a `preamble` overriding the viewer default.
    // Returns the Preview handles in DOM order.
    async scanAndAttach(root = document, options = {}) {
        const preamble = options.preamble ?? this.preamble;
        const examples = root.querySelectorAll('.example');
        const out = [];
        for (const example of examples) {
            const preview = example.querySelector('.preview');
            if (!preview) continue;
            const codeHost = example.querySelector('.code');

            // The sample is whatever the page put in the `.code` element.
            const sample = codeHost ? codeHost.textContent
                                    : (preview.dataset.sample ?? '');
            if (codeHost) codeHost.textContent = '';  // the editor renders here

            out.push(await this.addPreview(preview, {
                qml: preview.dataset.qml,
                preamble,
                sample,
                codeHost,
                fill: preview.dataset.fill ?? 'none',
            }));
        }
        return out;
    }
}

export { QmlComponentViewer, Preview, assembleQml };
