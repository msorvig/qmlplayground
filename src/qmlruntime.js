// QmlInstance + QmlRuntime
//
// QmlInstance owns one Qt wasm instance (the emscripten module). It can host
// many views. All wasm/process-level config lives here: build mode, the
// (optionally shared) compiled module, environment variables — including
// QT_QUICK_CONTROLS_STYLE, which is why style is per-instance.
//
// QmlRuntime is one *view*: a QML engine + window living inside an instance.
// Construct it with a container element and either let it create its own
// instance (the default — one wasm per view) or hand it an existing instance
// to share ("here, use this one"). Its public API (loadQml, loadProject,
// getErrors, setSizeMode, on, destroy, …) is unchanged from before, so
// callers that don't care about instancing keep working.

const buildModes = {
    'static': { basePath: 'static', shared: false },
    'shared': { basePath: 'shared', shared: true },
};

class QmlInstance {
    constructor(config = {}) {
        const {
            mode = 'static',
            loggingRules = '',
            module = null,
            environment = {},
            colorScheme = '',           // 'light' | 'dark' | 'auto'/'' (follow system)
        } = config;

        this.mode = mode;
        this.loggingRules = loggingRules;
        this._module = module;          // optional pre-compiled WebAssembly.Module
        this._environment = environment;
        this._colorScheme = colorScheme;

        const modeConfig = buildModes[mode] || buildModes.static;
        this._basePath = modeConfig.basePath;
        this._shared = modeConfig.shared;

        this.module = null;             // the emscripten module instance
        this._loadPromise = null;
        this._views = new Map();        // preview id -> QmlRuntime (for callback demux)

        console.log(`[qmlinstance] creating instance (mode=${mode})`);
    }

    // Boot the wasm. Idempotent: many views sharing an instance load it once.
    load() {
        if (this._loadPromise)
            return this._loadPromise;
        this._loadPromise = this._load();
        return this._loadPromise;
    }

    async _load() {
        const [{ qtLoad }, { qmlruntime_wasm_entry }] = await Promise.all([
            import(`./${this._basePath}/qtloader.js`),
            import(`./${this._basePath}/qmlruntime_wasm.js`),
        ]);

        const qtConfig = {
            entryFunction: qmlruntime_wasm_entry,
            // Start with no screens (an empty array, not unset — that avoids
            // the platform's "qtContainerElements not set" warning); each view
            // adds its own screen (qtAddContainerElement) when created.
            containerElements: [],
            onExit: (data) => console.warn('[qmlinstance] Qt exited', data),
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
        Object.assign(env, this._environment);
        if (Object.keys(env).length > 0)
            qtConfig.environment = env;

        if (this._module)
            qtConfig.module = this._module;

        this.module = await qtLoad({
            // .so paths that already carry a directory are resolvable URLs and
            // pass through. Bare names come from a side module's needed-library
            // list, which records basenames only; those live in qt/lib.
            locateFile: (path) => {
                if (!path.endsWith('.so'))
                    return `${this._basePath}/${path}`;
                return path.includes('/') ? path : `${this._basePath}/qt/lib/${path}`;
            },
            qt: qtConfig,
        });

        // Single registration per instance; the leading id routes each event
        // to the originating view.
        this.module.setOnError((id, line, column, message) =>
            this._views.get(id)?._emit('error', { line, column, message }));
        this.module.setOnWarning((id, line, column, message) =>
            this._views.get(id)?._emit('warning', { line, column, message }));
        this.module.setOnLoaded((id) =>
            this._views.get(id)?._emit('qmlloaded'));

        // Force the color scheme (process-global), before any view loads QML.
        if (this._colorScheme)
            this.module.setColorScheme(this._colorScheme);
    }

    get qtVersion() {
        return this.module ? this.module.getQtVersion() : '';
    }

    // Force the color scheme ('light' | 'dark' | 'auto'/''). Process-global,
    // live-settable; remembered so it survives a (re)load.
    setColorScheme(scheme) {
        this._colorScheme = scheme;
        if (this.module && scheme)
            this.module.setColorScheme(scheme);
    }

    // --- view lifecycle / ops, used by QmlRuntime ---

    _addView(container, view) {
        // Add a screen for this container, then create the view on it (the
        // C++ side binds the new window to the most recently added screen).
        this.module.qtAddContainerElement(container);
        const id = this.module.createPreview();
        this._views.set(id, view);
        return id;
    }

    _removeView(id, container) {
        if (!this.module) return;
        this.module.destroyPreview(id);
        this.module.qtRemoveContainerElement(container);
        this._views.delete(id);
    }

    _loadQml(id, source)        { this.module.loadQml(id, source); }
    _loadEntryFile(id, path)    { this.module.loadEntryFile(id, path); }
    _clearContent(id)           { this.module.clearContent(id); }
    _setSizeMode(id, fw, fh)    { this.module.setSizeMode(id, !!fw, !!fh); }
    _getErrors(id)              { return this.module.getErrors(id); }
    _resize(container)          { this.module.qtResizeContainerElement(container); }

    destroy() {
        // No clean wasm teardown; drop references and let GC reclaim once all
        // views are gone. Views call _removeView before this.
        this.module = null;
        this._loadPromise = null;
        this._views.clear();
    }
}

class QmlRuntime extends EventTarget {
    constructor(container, config = {}) {
        super();
        const { instance = null } = config;

        this.container = container;
        // Borrow the given instance, or own one built from the wasm-level
        // config (mode / module / environment / loggingRules).
        this._instance = instance;
        this._ownsInstance = !instance;
        this._instanceConfig = {
            mode: config.mode ?? 'static',
            module: config.module ?? null,
            environment: config.environment ?? {},
            loggingRules: config.loggingRules ?? '',
            colorScheme: config.colorScheme ?? '',
        };

        this._id = null;
        this.ready = false;
        this._loadStartTime = null;

        console.log(`[qmlruntime] creating runtime (${this._ownsInstance ? 'own instance' : 'shared instance'})`);
        this._resizeObserver = null;
        this._resizeEnabled = true;
        this._pendingResize = false;
    }

    // Compatibility: expose the build mode (used to be a field).
    get mode() { return this._instance ? this._instance.mode : this._instanceConfig.mode; }

    async load() {
        this._loadStartTime = performance.now();
        this._emit('loading');

        try {
            if (!this._instance)
                this._instance = new QmlInstance(this._instanceConfig);
            await this._instance.load();

            // Create this view (adds a screen for our container + a window).
            this._id = this._instance._addView(this.container, this);

            // Notify Qt of container size changes. When resize is disabled
            // (e.g. during an active splitter drag) we remember that a resize
            // is pending but don't forward it — leaving the canvas backing
            // buffer at its current size avoids the WebGL buffer-clear flash.
            this._resizeObserver = new ResizeObserver(() => {
                if (!this._resizeEnabled) {
                    this._pendingResize = true;
                    return;
                }
                this._instance._resize(this.container);
            });
            this._resizeObserver.observe(this.container);

            this.ready = true;
            const loadTime = performance.now() - this._loadStartTime;
            this._emit('ready', { loadTime, qtVersion: this._instance.qtVersion });
        } catch (e) {
            this._emit('error', { line: 0, column: 0, message: e.message });
            throw e;
        }
    }

    destroy() {
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._instance && this._id != null) {
            try { this._instance._removeView(this._id, this.container); }
            catch (e) { /* ignore cleanup errors */ }
        }
        this._id = null;
        this.ready = false;

        while (this.container.firstChild)
            this.container.removeChild(this.container.firstChild);

        if (this._ownsInstance && this._instance) {
            this._instance.destroy();
            this._instance = null;
        }
    }

    // Pause / resume forwarding resize events to Qt. While paused the canvas
    // backing buffer is left untouched (CSS stretches the existing pixels), so
    // an in-flight splitter drag doesn't flicker black. Resume replays a
    // pending resize, if any.
    setResizeEnabled(enabled) {
        if (this._resizeEnabled === enabled) return;
        this._resizeEnabled = enabled;
        if (enabled && this._pendingResize && this._instance) {
            this._instance._resize(this.container);
            this._pendingResize = false;
        }
    }

    // Set how the root item is sized: fill the canvas on an axis, or keep the
    // item's implicit size and center it. Set before loadQml.
    setSizeMode(fillWidth, fillHeight) {
        if (this.ready)
            this._instance._setSizeMode(this._id, fillWidth, fillHeight);
    }

    // Force the color scheme for this view's instance (process-global).
    setColorScheme(scheme) {
        this._instance?.setColorScheme(scheme);
    }

    loadQml(source) {
        if (!this.ready) throw new Error('Runtime not ready');
        this._instance._loadQml(this._id, source);
    }

    // Load a QmlProject. Writes every file into Emscripten's in-memory FS
    // under /project/, then asks the runtime to load the entry file from that
    // path. Lets Qt resolve cross-file imports, qmldir, and relative refs
    // through normal filesystem plumbing.
    loadProject(project) {
        if (!this.ready) throw new Error('Runtime not ready');
        const FS = this._instance.module.FS;
        if (!FS) throw new Error('Emscripten FS not exported from wasm');

        const root = '/project';
        project.writeTo(FS, root);
        this._instance._loadEntryFile(this._id, `${root}/${project.entry}`);
    }

    getErrors() {
        if (!this.ready) return [];
        try {
            return JSON.parse(this._instance._getErrors(this._id));
        } catch (e) {
            return [];
        }
    }

    clear() {
        if (this.ready)
            this._instance._clearContent(this._id);
    }

    _emit(type, detail = {}) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    on(event, callback) {
        this.addEventListener(event, (e) => callback(e.detail));
        return this; // Allow chaining
    }
}

export { QmlRuntime, QmlInstance };
