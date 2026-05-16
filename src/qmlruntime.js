// QmlRuntime - JavaScript wrapper for Qt QML WebAssembly runtime

const buildModes = {
    'static': { basePath: 'static', shared: false },
    'shared': { basePath: 'shared', shared: true },
};

class QmlRuntime extends EventTarget {
    constructor(container, config = {}) {
        super();
        const {
            mode = 'static',
            loggingRules = '',
        } = config;

        this.container = container;
        this.mode = mode;
        this.loggingRules = loggingRules;
        const modeConfig = buildModes[mode] || buildModes.static;
        this._basePath = modeConfig.basePath;
        this._shared = modeConfig.shared;
        this.instance = null;
        this.ready = false;
        this._loadStartTime = null;
        this._resizeObserver = null;
        this._resizeEnabled = true;
        this._pendingResizeEntry = null;
    }

    // Load the Qt runtime
    async load() {
        this._loadStartTime = performance.now();
        this._emit('loading');

        try {
            const [{ qtLoad }, { qmlruntime_wasm_entry }] = await Promise.all([
                import(`./${this._basePath}/qtloader.js`),
                import(`./${this._basePath}/qmlruntime_wasm.js`),
            ]);

            const qtConfig = {
                onLoaded: () => this._emit('qtloaded'),
                onExit: (data) => this._emit('exit', { data }),
                entryFunction: qmlruntime_wasm_entry,
                containerElements: [this.container],
            };

            if (this._shared) {
                qtConfig.qtdir = `${this._basePath}/qt`;
                qtConfig.preload = [`${this._basePath}/qt_plugins.json`];
            }

            const env = {};
            if (this._shared)
                env.QML_IMPORT_PATH = `${this._basePath}/qt/qml`;
            if (this.loggingRules)
                env.QT_LOGGING_RULES = this.loggingRules.split('\n').map(s => s.trim()).filter(Boolean).join(';');
            if (Object.keys(env).length > 0)
                qtConfig.environment = env;

            this.instance = await qtLoad({
                locateFile: (path) => path.endsWith('.so') ? path : `${this._basePath}/${path}`,
                qt: qtConfig,
            });

            // Set up callbacks
            this.instance.setOnError((line, column, message) => {
                console.log('[qmlruntime] onError:', line, column, message);
                this._emit('error', { line, column, message });
            });

            this.instance.setOnWarning((line, column, message) => {
                console.log('[qmlruntime] onWarning:', line, column, message);
                this._emit('warning', { line, column, message });
            });

            this.instance.setOnLoaded(() => {
                console.log('[qmlruntime] onLoaded (QML scene ready)');
                this._emit('qmlloaded');
            });

            // Notify Qt of container size changes. When resize is disabled
            // (e.g. during an active splitter drag) we record the latest
            // entry but don't forward it — leaving the canvas backing buffer
            // at its current size avoids the WebGL-spec buffer-clear that
            // would otherwise show a black flash between resize and the next
            // paint. The pending entry is flushed when resize is re-enabled.
            this._resizeObserver = new ResizeObserver((entries) => {
                const entry = entries[entries.length - 1];
                if (!this._resizeEnabled) {
                    this._pendingResizeEntry = entry;
                    return;
                }
                this.instance.qtResizeAllScreens(entry);
            });
            this._resizeObserver.observe(this.container);

            this.ready = true;
            const loadTime = performance.now() - this._loadStartTime;
            const qtVersion = this.instance.getQtVersion();
            this._emit('ready', { loadTime, qtVersion });

        } catch (e) {
            this._emit('error', { line: 0, column: 0, message: e.message });
            throw e;
        }
    }

    // Destroy the runtime and clean up
    destroy() {
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }

        if (this.instance) {
            try {
                this.instance.clearContent();
            } catch (e) {
                // ignore cleanup errors
            }
            this.instance = null;
        }

        this.ready = false;

        // Clear container DOM (canvases, etc.)
        while (this.container.firstChild) {
            this.container.removeChild(this.container.firstChild);
        }
    }

    // Pause / resume forwarding ResizeObserver events to Qt. While paused
    // the canvas backing buffer is left untouched (CSS stretches the
    // existing pixels), so an in-flight splitter drag doesn't flicker
    // black. Resume replays the latest pending size, if any.
    setResizeEnabled(enabled) {
        if (this._resizeEnabled === enabled) return;
        this._resizeEnabled = enabled;
        if (enabled && this._pendingResizeEntry && this.instance) {
            this.instance.qtResizeAllScreens(this._pendingResizeEntry);
            this._pendingResizeEntry = null;
        }
    }

    // Load QML source code
    loadQml(source) {
        if (!this.ready) {
            throw new Error('Runtime not ready');
        }
        console.log('[qmlruntime] loadQml called');
        this.instance.loadQml(source);
        console.log('[qmlruntime] loadQml returned');
    }

    // Load a QmlProject. Writes every file into Emscripten's in-memory FS
    // under /project/, then asks the C++ runtime to load the entry file
    // from that path. Lets Qt resolve cross-file imports, qmldir, and
    // relative image/URL references through normal filesystem plumbing.
    loadProject(project) {
        if (!this.ready) throw new Error('Runtime not ready');
        const FS = this.instance.FS;
        if (!FS) throw new Error('Emscripten FS not exported from wasm');

        const root = '/project';
        project.writeTo(FS, root);
        this.instance.loadEntryFile(`${root}/${project.entry}`);
    }

    // Get errors and warnings from last load
    getErrors() {
        if (!this.ready) return [];
        try {
            return JSON.parse(this.instance.getErrors());
        } catch (e) {
            return [];
        }
    }

    // Clear the QML scene
    clear() {
        if (this.ready) {
            this.instance.clearContent();
        }
    }

    // Emit a custom event
    _emit(type, detail = {}) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    // Convenience method to add event listeners
    on(event, callback) {
        this.addEventListener(event, (e) => callback(e.detail));
        return this; // Allow chaining
    }
}

export { QmlRuntime };
