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
//
// Hot reload: with `hotReload: true` the instance runs qtdeclarative's
// QmlPreview debug service in-process (see main.cpp). A view whose `hotReload`
// flag is set then patches the running scene when a project's file contents
// change, instead of recreating it — the live objects keep their state.

const buildModes = {
    'static': { basePath: 'static', shared: false },
    'shared': { basePath: 'shared', shared: true },
};

// The build directory (static/ or shared/) as a path relative to the current
// document.
//
// Emscripten resolves locateFile() results against the page, qtloader fetches
// qtdir and preload against the page, and Qt dlopens QML plugins found under
// QML_IMPORT_PATH the same way — none of them resolve against this module. A
// front-end page in a subdirectory would therefore hunt for the runtime assets
// underneath that subdirectory. Deriving the path from this module's own URL
// keeps all of it correct whatever depth the page sits at, and yields the
// plain "static" / "shared" of old for a page next to this module.
//
// Note this is deliberately a relative path rather than an absolute URL: the
// value reaches Qt as a plain path (QML_IMPORT_PATH), where a scheme would
// not survive path normalisation.
function assetBaseFor(basePath) {
    const target = new URL(`./${basePath}/`, import.meta.url);
    const page = new URL('.', document.baseURI);

    // Served from a different origin: only an absolute URL can express it.
    if (target.origin !== page.origin)
        return target.href.replace(/\/$/, '');

    const from = page.pathname.split('/').filter(Boolean);
    const to = target.pathname.split('/').filter(Boolean);
    let common = 0;
    while (common < from.length && common < to.length && from[common] === to[common])
        ++common;

    return [
        ...Array(from.length - common).fill('..'),
        ...to.slice(common),
    ].join('/') || '.';
}

function snapshotFiles(project) {
    return new Map(project.listPaths().map(p => [p, project.getFileContent(p)]));
}

// Remove `path` and everything below it from an Emscripten FS. A missing
// path is fine.
function removeTree(FS, path) {
    let stat;
    try { stat = FS.stat(path); } catch (_) { return; }
    if (FS.isDir(stat.mode)) {
        for (const name of FS.readdir(path)) {
            if (name !== '.' && name !== '..')
                removeTree(FS, `${path}/${name}`);
        }
        FS.rmdir(path);
    } else {
        FS.unlink(path);
    }
}

// Parse QQmlComponent::errorString(): one QQmlError::toString() per line,
// "url:line[:column]: description".
function parseQmlErrors(text) {
    const issues = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const m = line.match(/^(.*?):(\d+)(?::(\d+))?: (.*)$/);
        issues.push(m ? { file: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : 0,
                          message: m[4], type: 'error' }
                      : { line: 0, column: 0, message: line, type: 'error' });
    }
    return issues;
}

class QmlInstance {
    constructor(config = {}) {
        const {
            mode = 'static',
            loggingRules = '',
            module = null,
            environment = {},
            colorScheme = '',           // 'light' | 'dark' | 'auto'/'' (follow system)
            hotReload = false,          // start the QmlPreview service (see below)
            accessibility = false,      // expose the scene to screen readers
        } = config;

        this.mode = mode;
        this.loggingRules = loggingRules;
        this._module = module;          // optional pre-compiled WebAssembly.Module
        this._environment = environment;
        this._colorScheme = colorScheme;

        const modeConfig = buildModes[mode] || buildModes.static;
        // Two forms of the same directory: _basePath is resolved against this
        // module (import specifiers), _assetBase against the page (fetches).
        this._basePath = modeConfig.basePath;
        this._assetBase = assetBaseFor(modeConfig.basePath);
        this._shared = modeConfig.shared;

        this.module = null;             // the emscripten module instance
        this._loadPromise = null;
        this._views = new Map();        // preview id -> QmlRuntime (for callback demux)

        // Hot reload. `_hotReload` is the request; `hotReload` turns true once
        // the service has confirmed in-place updates.
        this._hotReload = hotReload;
        this.hotReload = false;
        // Accessibility: Qt mirrors the scene as accessible HTML elements.
        // Read by the platform plugin at startup, so it is an env var.
        this.accessibility = accessibility;
        this._previewSink = null;       // view with a hot reload in flight
        this._lastPreviewView = null;   // ... or the last one that had

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
        // Import specifiers resolve against this module, so they take the
        // plain directory name; everything below is fetched by the page and
        // takes _assetBase.
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
            qtConfig.qtdir = `${this._assetBase}/qt`;
            qtConfig.preload = [`${this._assetBase}/qt_plugins.json`];
            // The connector and service are plugins the loader must find in
            // the FS at startup; only fetch them when asked for.
            if (this._hotReload)
                qtConfig.preload.push(`${this._assetBase}/qt_plugins_hotreload.json`);
        }

        const env = {};
        if (this._shared)
            env.QML_IMPORT_PATH = `${this._assetBase}/qt/qml`;
        if (this.loggingRules)
            env.QT_LOGGING_RULES = this.loggingRules.split('\n').map(s => s.trim()).filter(Boolean).join(';');
        if (this.accessibility)
            env.QT_WASM_ENABLE_ACCESSIBILITY = '1';
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
                    return `${this._assetBase}/${path}`;
                return path.includes('/') ? path : `${this._assetBase}/qt/lib/${path}`;
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
            this._views.get(id)?._onLoaded());

        // Force the color scheme (process-global), before any view loads QML.
        if (this._colorScheme)
            this.module.setColorScheme(this._colorScheme);

        // Before any view: engines register with the service when created.
        if (this._hotReload)
            this._startHotReload();
    }

    // --- hot reload (QmlPreview service) ---

    // Start the in-process QmlPreview service and ask for in-place updates.
    // The Confirmation arrives synchronously and sets `hotReload`.
    _startHotReload() {
        this.module.setOnPreviewMessage((type, payload) => this._onPreviewMessage(type, payload));
        if (!this.module.startPreviewService()) {
            console.warn('[qmlinstance] hot reload unavailable: QmlPreview service did not start');
            return;
        }
        this.module.previewConfigure(true);
        if (!this.hotReload)
            console.warn('[qmlinstance] hot reload unavailable: in-place updates not confirmed');
    }

    _onPreviewMessage(type, payload) {
        switch (type) {
        case 'confirmation':
            this.hotReload = payload === 'true';
            console.log(`[qmlinstance] hot reload ${this.hotReload ? 'enabled' : 'declined by the service'}`);
            return;
        case 'request':
            // The service asks for a file it was not given. We push files
            // ahead of every Load; anything else falls back to MEMFS.
            return;
        case 'fps':
            return;
        }
        // error / hotReloadFailure: to the view whose hot reload is in flight,
        // else the last one — a recompile that had to wait for an import can
        // report after the call returned.
        (this._previewSink ?? this._lastPreviewView)?._onPreviewMessage(type, payload);
    }

    _previewSendFile(path, contents) { this.module.previewSendFile(path, contents); }
    _previewLoad(url)                { this.module.previewLoad(url); }
    _previewClearCache()             { this.module.previewClearCache(); }

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
    _refreshRoot(id)            { return JSON.parse(this.module.refreshRoot(id)); }
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
            hotReload: config.hotReload ?? false,
            accessibility: config.accessibility ?? false,
        };

        // Use hot reload for loadProject() when the instance offers it. May be
        // flipped at any time; see hotReloadAvailable.
        this.hotReload = config.hotReload ?? false;
        this._lastLoad = null;          // { entry, files, ok, hot } of the last loadProject
        this._lastRoot = null;          // root state after the last usable load (health baseline)
        this._hotErrors = [];           // errors of the last hot reload
        this._hotMessages = null;       // collects service messages while one is in flight

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

    // True once the instance's QmlPreview service has confirmed in-place
    // updates. Requires the instance to have been created with
    // `hotReload: true`; there is no enabling it after the fact.
    get hotReloadAvailable() { return !!this._instance?.hotReload; }

    // True when the instance was started with accessibility enabled.
    get accessibility() { return !!(this._instance?.accessibility ?? this._instanceConfig.accessibility); }

    async load() {
        this._loadStartTime = performance.now();
        this._emit('loading');

        try {
            if (!this._instance)
                this._instance = new QmlInstance(this._instanceConfig);
            await this._instance.load();

            // Create this view (adds a screen for our container + a window).
            this._id = this._instance._addView(this.container, this);
            // Where loadProject() writes this view's files. Per view, since
            // views sharing an instance share one filesystem — and documents
            // are addressed by URL, so two views must not load different
            // documents from the same path.
            this._projectRoot = `/projects/${this._id}`;

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
            try {
                if (this._lastLoad)
                    removeTree(this._instance.module.FS, this._projectRoot);
                this._instance._removeView(this._id, this.container);
            } catch (e) { /* ignore cleanup errors */ }
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
        this._lastLoad = null;   // a setData() document has no URL to hot reload
        this._instance._loadQml(this._id, source);
    }

    // Load a QmlProject. Writes every file into Emscripten's in-memory FS
    // under this view's directory, then asks the runtime to load the entry
    // file from that path. Lets Qt resolve cross-file imports, qmldir, and
    // relative refs through normal filesystem plumbing.
    //
    // With hot reload on and available, a project that differs from the last
    // one only in the contents of some files is patched in place instead: the
    // changed documents are recompiled and the live objects keep their state.
    // Anything else — the first load, another entry, added or removed files,
    // a patch the service cannot apply — is a full load.
    loadProject(project) {
        if (!this.ready) throw new Error('Runtime not ready');
        const FS = this._instance.module.FS;
        if (!FS) throw new Error('Emscripten FS not exported from wasm');

        const root = this._projectRoot;
        if (this._hotReloadProject(project, FS, root))
            return;

        // Full load. Contents pushed to the service shadow the filesystem;
        // drop them so the type loader reads what we write below.
        if (this._instance.hotReload)
            this._instance._previewClearCache();
        project.writeTo(FS, root);
        this._lastLoad = { entry: project.entry, files: snapshotFiles(project), ok: false, hot: false };
        this._hotErrors = [];
        this._instance._loadEntryFile(this._id, `${root}/${project.entry}`);
    }

    // The in-place path of loadProject(). Returns false when a full load is
    // needed instead.
    _hotReloadProject(project, FS, root) {
        if (!this.hotReload || !this._instance.hotReload)
            return false;
        const last = this._lastLoad;
        if (!last || !last.ok || last.entry !== project.entry)
            return false;

        // Only contents can be patched; a changed file set needs a full load.
        const paths = project.listPaths();
        if (paths.length !== last.files.size || !paths.every(p => last.files.has(p)))
            return false;
        const changed = paths.filter(p => project.getFileContent(p) !== last.files.get(p));
        if (changed.length === 0)
            return false;   // an explicit re-run of the same project restarts it

        // Push the changed documents, then Load. The service dispatches on
        // this thread, so for local documents everything — recompile, patch,
        // error reports — has happened when previewLoad() returns.
        const t0 = performance.now();
        this._hotMessages = [];
        this._instance._previewSink = this;
        this._instance._lastPreviewView = this;
        try {
            for (const path of changed) {
                const contents = project.getFileContent(path);
                FS.writeFile(`${root}/${path}`, contents);   // keep the fallback source in sync
                this._instance._previewSendFile(`${root}/${path}`, contents);
            }
            this._instance._previewLoad(`file://${root}/${project.entry}`);
        } finally {
            this._instance._previewSink = null;
        }
        const messages = this._hotMessages;
        this._hotMessages = null;

        const failure = messages.find(m => m.type === 'hotReloadFailure');
        if (failure) {
            console.warn(`[qmlruntime] hot reload failed (${failure.payload}); reloading`);
            return false;
        }

        // A rebuilt root is re-parented and re-sized by refreshRoot(). Some
        // roots come back unusable: deleted by the service, without a size,
        // or — a Control whose base type supplies its delegates — stripped
        // of all children by the rebuild (the service does not recreate
        // them). Those need a full load.
        const rootInfo = this._instance._refreshRoot(this._id);
        const hadErrors = messages.some(m => m.type === 'error');
        const lostChildren = rootInfo.children === 0 && (this._lastRoot?.children ?? 0) > 0;
        if (rootInfo.kind === 'item' && !hadErrors
                && (!rootInfo.alive || rootInfo.width <= 0 || rootInfo.height <= 0 || lostChildren)) {
            console.warn('[qmlruntime] hot reload left no usable root; reloading', rootInfo);
            return false;
        }
        if (!hadErrors)
            this._lastRoot = rootInfo;

        for (const path of changed)
            last.files.set(path, project.getFileContent(path));
        last.hot = true;
        this._hotErrors = messages.filter(m => m.type === 'error')
                                  .flatMap(m => parseQmlErrors(m.payload));
        for (const issue of this._hotErrors)
            this._emit('error', issue);
        const elapsed = performance.now() - t0;
        console.log('[qmlruntime] hot reloaded', changed.join(', '), `${elapsed.toFixed(1)}ms`, rootInfo);
        this._emit('qmlloaded', { hot: true, changed, root: rootInfo, elapsed });
        return true;
    }

    // Service messages attributed to this view.
    _onPreviewMessage(type, payload) {
        if (this._hotMessages) {
            this._hotMessages.push({ type, payload });
            return;
        }
        // Late report from a recompile that waited for an import.
        if (type === 'error') {
            for (const issue of parseQmlErrors(payload)) {
                this._hotErrors.push(issue);
                this._emit('error', issue);
            }
        } else if (type === 'hotReloadFailure') {
            console.warn(`[qmlruntime] hot reload failed (${payload})`);
            this._emit('error', { line: 0, column: 0, message: `Hot reload failed: ${payload}` });
        }
    }

    // A full load finished (successfully or not).
    _onLoaded() {
        if (this._lastLoad) {
            this._lastLoad.ok = !this.getErrors().some(i => i.type === 'error');
            // Baseline for the hot path's health check.
            this._lastRoot = this._lastLoad.ok ? this._instance._refreshRoot(this._id) : null;
        }
        this._emit('qmlloaded', { hot: false });
    }

    getErrors() {
        if (!this.ready) return [];
        if (this._lastLoad?.hot)
            return [...this._hotErrors];
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
