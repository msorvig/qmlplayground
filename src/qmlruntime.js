/**
 * Qt for WebAssembly runtime: {@link QmlInstance} is a Qt process,
 * {@link QmlRuntime} is a QML view inside one.
 *
 * A QmlInstance holds the emscripten module and the settings that are global
 * to the process: build mode, environment variables (including
 * `QT_QUICK_CONTROLS_STYLE`, so the Controls style is per instance), color
 * scheme, hot reload and accessibility. One instance can host several views.
 *
 * A QmlRuntime is a QML engine and window rendered into a DOM element. It
 * creates a private instance unless one is passed in its config.
 *
 * @module qmlruntime
 */

/**
 * One QML error or warning.
 * @typedef {Object} QmlIssue
 * @property {number} line - Line in the document, 0 when unknown.
 * @property {number} column - Column in the document, 0 when unknown.
 * @property {string} message - Description as reported by the QML engine.
 * @property {'error'|'warning'} [type] - Set on {@link QmlRuntime.getErrors} results. Absent on `error` and `warning` event details, where the event name gives the type.
 * @property {string} [file] - Document URL. Set on errors from a hot reload.
 */

/**
 * Detail of the `ready` event.
 * @typedef {Object} QmlReady
 * @property {number} loadTime - Milliseconds from {@link QmlRuntime.load} to ready.
 * @property {string} qtVersion - Version of the loaded Qt.
 */

/**
 * Detail of the `qmlloaded` event.
 * @typedef {Object} QmlLoaded
 * @property {boolean} hot - `true` when the running scene was patched in place, `false` for a full load.
 * @property {string[]} [changed] - Hot reload only: project paths whose contents changed.
 * @property {number} [elapsed] - Hot reload only: milliseconds the reload took.
 * @property {Object} [root] - Hot reload only: state of the root item after the patch.
 */

/**
 * Configuration for {@link QmlInstance}.
 * @typedef {Object} QmlInstanceConfig
 * @property {'static'|'shared'} [mode='static'] - Runtime build to load. `static` is one wasm binary with all Qt modules linked in; `shared` loads Qt libraries and QML modules on demand.
 * @property {string} [loggingRules=''] - Qt logging rules, one per line. Passed as `QT_LOGGING_RULES`.
 * @property {WebAssembly.Module|null} [module=null] - Pre-compiled main module. Skips fetching and compiling, so several instances can share one compilation.
 * @property {Record<string, string>} [environment={}] - Environment variables for the Qt process. Applied last; override variables set by the other options.
 * @property {'light'|'dark'|'auto'|''} [colorScheme=''] - Forced color scheme. `auto` or empty follows the system.
 * @property {boolean} [hotReload=false] - Run the QmlPreview service so views can patch a running scene in place. Shared builds also preload the service plugins.
 * @property {boolean} [accessibility=false] - Expose the scene to screen readers. Sets `QT_WASM_ENABLE_ACCESSIBILITY=1`.
 */

/**
 * Configuration for {@link QmlRuntime}. With `instance` set, the view joins
 * that instance and the remaining options are ignored, except `hotReload`,
 * which also sets the view's own flag. Without it, the remaining options
 * configure the private {@link QmlInstance} the view creates; see
 * {@link QmlInstanceConfig} for their meaning.
 * @typedef {Object} QmlRuntimeConfig
 * @property {QmlInstance|null} [instance=null] - Existing instance to render into.
 * @property {'static'|'shared'} [mode='static']
 * @property {string} [loggingRules='']
 * @property {WebAssembly.Module|null} [module=null]
 * @property {Record<string, string>} [environment={}]
 * @property {'light'|'dark'|'auto'|''} [colorScheme='']
 * @property {boolean} [hotReload=false] - Enables hot reload for the private instance and for this view ({@link QmlRuntime.hotReload}).
 * @property {boolean} [accessibility=false]
 */

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

/**
 * A Qt for WebAssembly process: the emscripten module and the settings that
 * apply to the whole process. Hosts one or more {@link QmlRuntime} views.
 *
 * Create one explicitly to share a process between views:
 *
 * ```js
 * const instance = new QmlInstance();
 * const a = new QmlRuntime(containerA, { instance });
 * const b = new QmlRuntime(containerB, { instance });
 * await Promise.all([a.load(), b.load()]);
 * ```
 *
 * Views sharing an instance share one filesystem, one Controls style and one
 * color scheme.
 */
class QmlInstance {
    /** @param {QmlInstanceConfig} [config] */
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

        /** Build mode this instance loads. @type {'static'|'shared'} */
        this.mode = mode;
        /** Qt logging rules passed to the process. @type {string} */
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

        /** The emscripten module. `null` until {@link load} resolves. */
        this.module = null;
        this._loadPromise = null;
        this._views = new Map();        // preview id -> QmlRuntime (for callback demux)

        this._hotReload = hotReload;    // the request; `hotReload` is the confirmation
        /**
         * `true` once the QmlPreview service has confirmed in-place updates. Set during {@link load} when configured with `hotReload: true`.
         * @type {boolean}
         */
        this.hotReload = false;
        // Read by the platform plugin at startup, so it is an env var.
        /** Whether the scene is exposed to screen readers. @type {boolean} */
        this.accessibility = accessibility;
        this._previewSink = null;       // view with a hot reload in flight
        this._lastPreviewView = null;   // ... or the last one that had

        console.log(`[qmlinstance] creating instance (mode=${mode})`);
    }

    /**
     * Loads and starts the Qt process. Every call returns the same promise, so
     * views sharing an instance load it once.
     * @returns {Promise<void>}
     */
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

    /**
     * Version of the loaded Qt. Empty until {@link load} resolves.
     * @type {string}
     */
    get qtVersion() {
        return this.module ? this.module.getQtVersion() : '';
    }

    /**
     * Forces the color scheme for every view in this instance. Applied
     * immediately when loaded, otherwise on load.
     * @param {'light'|'dark'|'auto'} scheme - `auto` follows the system.
     */
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

    /**
     * Releases the instance. Destroy its views first. The wasm memory is
     * reclaimed by the garbage collector once nothing references the module.
     */
    destroy() {
        // No clean wasm teardown; drop references and let GC reclaim once all
        // views are gone. Views call _removeView before this.
        this.module = null;
        this._loadPromise = null;
        this._views.clear();
    }
}

/**
 * QmlRuntime provides a QML view rendered into a DOM element. Add it to the
 * html document by passing a parent element to its constructor.
 *
 * ```js
 * const runtime = new QmlRuntime(document.getElementById('preview'));
 * runtime.on('ready', () => runtime.loadQml('import QtQuick\nRectangle { color: "red" }'));
 * await runtime.load();
 * ```
 *
 * Pass a {@link QmlRuntimeConfig | config object} to QmlRuntime to set config
 * options. Config options include setting the build mode (static or shared
 * libraries), and options for enabling accessibility and hot reloading
 * support.
 *
 * ```js
 * const runtime = new QmlRuntime(container, {
 *     mode: 'shared',
 *     accessibility: true,
 *     hotReload: true,
 * });
 * ```
 *
 * Each QmlRuntime runs on a {@link QmlInstance} which manages the WebAssembly
 * instance. Sharing a QmlInstance between multiple runtimes is possible, to
 * do so create the QmlInstance first and then pass it to the QmlRuntime
 * constructor.
 *
 * ```js
 * const instance = new QmlInstance();
 * const a = new QmlRuntime(containerA, { instance });
 * const b = new QmlRuntime(containerB, { instance });
 * await Promise.all([a.load(), b.load()]);
 * ```
 *
 * QmlRuntime provides events for reacting to load state and QML compiler
 * warnings and errors. Connect to each event using the
 * {@link QmlRuntime.on | on} method, which passes the event's `detail` to the
 * callback.
 *
 * | Event | Detail | When |
 * |---|---|---|
 * | `loading` | none | {@link QmlRuntime.load | load} started |
 * | `ready` | {@link QmlReady} | The view can load QML |
 * | `error` | {@link QmlIssue} | A QML error, or {@link QmlRuntime.load | load} failed |
 * | `warning` | {@link QmlIssue} | A QML warning |
 * | `qmlloaded` | {@link QmlLoaded} | A load finished, with or without errors; see {@link QmlRuntime.getErrors | getErrors} |
 *
 * A handler for each event:
 *
 * ```js
 * runtime.on('loading', () => console.log('loading Qt'))
 *        .on('ready', ({ loadTime, qtVersion }) => console.log(`Qt ${qtVersion} ready in ${loadTime} ms`))
 *        .on('error', ({ line, column, message }) => console.error(`${line}:${column}: ${message}`))
 *        .on('warning', ({ line, column, message }) => console.warn(`${line}:${column}: ${message}`))
 *        .on('qmlloaded', ({ hot }) => console.log(hot ? 'hot reloaded' : 'loaded', runtime.getErrors()));
 * ```
 */
class QmlRuntime extends EventTarget {
    /**
     * @param {HTMLElement} container - Element the view renders into.
     * @param {QmlRuntimeConfig} [config]
     */
    constructor(container, config = {}) {
        super();
        const { instance = null } = config;

        /** Element the view renders into. @type {HTMLElement} */
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

        /**
         * Use hot reload in {@link loadProject} when {@link hotReloadAvailable} is `true`. Can be changed at any time.
         * @type {boolean}
         */
        this.hotReload = config.hotReload ?? false;
        this._lastLoad = null;          // { entry, files, ok, hot } of the last loadProject
        this._lastRoot = null;          // root state after the last usable load (health baseline)
        this._hotErrors = [];           // errors of the last hot reload
        this._hotMessages = null;       // collects service messages while one is in flight

        this._id = null;
        /**
         * `true` from {@link load} resolving until {@link destroy}.
         * @type {boolean}
         */
        this.ready = false;
        this._loadStartTime = null;

        console.log(`[qmlruntime] creating runtime (${this._ownsInstance ? 'own instance' : 'shared instance'})`);
        this._resizeObserver = null;
        this._resizeEnabled = true;
        this._pendingResize = false;
    }

    /** Build mode of the view's instance. @type {'static'|'shared'} */
    get mode() { return this._instance ? this._instance.mode : this._instanceConfig.mode; }

    /**
     * `true` when the instance's QmlPreview service accepts in-place updates.
     * Requires an instance created with `hotReload: true`; it cannot be
     * enabled later.
     * @type {boolean}
     */
    get hotReloadAvailable() { return !!this._instance?.hotReload; }

    /** Whether the instance exposes the scene to screen readers. @type {boolean} */
    get accessibility() { return !!(this._instance?.accessibility ?? this._instanceConfig.accessibility); }

    /**
     * Loads the instance if needed, then creates the view's window in
     * {@link container}. Emits `loading` first and `ready` on success. On
     * failure emits `error` and rejects.
     * @returns {Promise<void>}
     */
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

    /**
     * Destroys the view: removes its window and project files, empties
     * {@link container}, and destroys the instance if the view owns it.
     */
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

    /**
     * Pauses or resumes forwarding container size changes to Qt. While paused
     * the canvas keeps its backing store and is stretched by CSS, which avoids
     * flicker during a splitter drag. Resuming applies a pending resize.
     * @param {boolean} enabled
     */
    setResizeEnabled(enabled) {
        if (this._resizeEnabled === enabled) return;
        this._resizeEnabled = enabled;
        if (enabled && this._pendingResize && this._instance) {
            this._instance._resize(this.container);
            this._pendingResize = false;
        }
    }

    /**
     * Sets how the root item is sized on each axis: stretched to the window
     * (`true`), or kept at its implicit size and centered (`false`). Default
     * is `true` for both. Applies to the current root and to later loads. No
     * effect before `ready`.
     * @param {boolean} fillWidth
     * @param {boolean} fillHeight
     */
    setSizeMode(fillWidth, fillHeight) {
        if (this.ready)
            this._instance._setSizeMode(this._id, fillWidth, fillHeight);
    }

    /**
     * Forces the color scheme of the view's instance. Affects every view
     * sharing the instance.
     * @param {'light'|'dark'|'auto'} scheme - `auto` follows the system.
     */
    setColorScheme(scheme) {
        this._instance?.setColorScheme(scheme);
    }

    /**
     * Loads a QML document from a string, replacing the current scene.
     * Completion is reported by `qmlloaded`, problems by `error` and
     * `warning`. The document has no URL, so relative imports do not resolve
     * and hot reload does not apply; use {@link loadProject} for those.
     * @param {string} source - QML source.
     * @throws {Error} When called before `ready`.
     */
    loadQml(source) {
        if (!this.ready) throw new Error('Runtime not ready');
        this._lastLoad = null;   // a setData() document has no URL to hot reload
        this._instance._loadQml(this._id, source);
    }

    /**
     * Loads a project: writes its files to the in-memory filesystem, in a
     * directory private to this view, and loads the entry file from there.
     * Imports between files, `qmldir` and relative URLs resolve as on disk.
     *
     * When {@link hotReload} and {@link hotReloadAvailable} are both `true`
     * and the project differs from the previous load only in file contents,
     * the changed documents are recompiled and patched into the running scene,
     * and live objects keep their state. Everything else is a full load: the
     * first load, a different entry file, added or removed files, an unchanged
     * project, or a patch the service rejects. The `qmlloaded` detail tells
     * which happened.
     * @param {import('./qmlproject.js').QmlProject} project
     * @throws {Error} When called before `ready`.
     */
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

    /**
     * Returns the errors and warnings of the last load. Empty before `ready`.
     * @returns {QmlIssue[]}
     */
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

    /** Removes the loaded scene. */
    clear() {
        if (this.ready)
            this._instance._clearContent(this._id);
    }

    _emit(type, detail = {}) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    /**
     * Adds a listener that receives the event's `detail`. See the class
     * description for the events.
     * @param {string} event
     * @param {(detail: any) => void} callback
     * @returns {this}
     */
    on(event, callback) {
        this.addEventListener(event, (e) => callback(e.detail));
        return this;
    }
}

export { QmlRuntime, QmlInstance };
