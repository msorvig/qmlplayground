/**
 * QmlRuntime renders a QML view into a DOM element, taking QML source code
 * from a single source file or a multi-file project.
 *
 * The runtime provides load state events, as well as events which provide
 * QML engine warnings and errors.
 *
 * The runtime provides several properties for controlling rendering and
 * behavior, including build mode (static, or shared libraries), Qt Quick
 * Controls style, color scheme, logging rules, accessibility, root item
 * sizing, and hot reload. See the {@link QmlRuntime} documentation.
 *
 * QmlRuntime is built from two components, which can also be used directly.
 *
 * {@link QmlInstance} is the Qt process. It holds the WebAssembly instance
 * and the settings that apply to the process as a whole.
 *
 * {@link QmlViewer} is one QML view on an instance. It holds the view
 * settings and the load and error API.
 *
 * Several viewers can share one instance. The wasm then loads once, and the
 * views share a filesystem, Controls style and color scheme.
 *
 * @module qmlruntime
 */

/**
 * One QML error or warning.
 * @typedef {Object} QmlIssue
 * @property {number} line - Line in the document, 0 when unknown.
 * @property {number} column - Column in the document, 0 when unknown.
 * @property {string} message - Description as reported by the QML engine.
 * @property {'error'|'warning'} [type] - Set on {@link QmlViewer.getErrors} results. Absent on `error` and `warning` event details, where the event name gives the type.
 * @property {string} [file] - Document URL. Set on errors from a hot reload.
 */

/**
 * Detail of the `ready` event.
 * @typedef {Object} QmlReady
 * @property {number} loadTime - Milliseconds from `load()` to ready.
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
 * Configuration for {@link QmlInstance}. Every option is fixed once the
 * instance is loaded, except `colorScheme`.
 * @typedef {Object} QmlInstanceConfig
 * @property {'static'|'shared'} [mode='static'] - Runtime build to load. `static` is one wasm binary with all Qt modules linked in; `shared` loads Qt libraries and QML modules on demand.
 * @property {WebAssembly.Module|Promise<WebAssembly.Module>|null} [module=null] - Pre-compiled main module. Skips fetching and compiling, so several instances can share one compilation.
 * @property {Record<string, string>} [environment={}] - Environment variables for the Qt process. Applied last; override variables set by the other options.
 * @property {string} [loggingRules=''] - Qt logging rules, one per line. Passed as `QT_LOGGING_RULES`.
 * @property {string} [controlsStyle=''] - Qt Quick Controls style, e.g. `Material`. Empty uses the build's default. Passed as `QT_QUICK_CONTROLS_STYLE`.
 * @property {'light'|'dark'|'auto'|''} [colorScheme=''] - Forced color scheme. `auto` or empty follows the system.
 * @property {boolean} [hotReload=false] - Run the QmlPreview service so viewers can patch a running scene in place. Shared builds also preload the service plugins.
 * @property {boolean} [accessibility=false] - Expose the scene to screen readers. Sets `QT_WASM_ENABLE_ACCESSIBILITY=1`.
 */

/**
 * Configuration for {@link QmlViewer}. Every option except `container` is
 * also a property that can be changed at any time.
 * @typedef {Object} QmlViewerConfig
 * @property {HTMLElement} container - Element the view renders into.
 * @property {boolean} [fillWidth=true] - Stretch the root item to the window width. When `false` the root keeps its implicit width and is centered.
 * @property {boolean} [fillHeight=true] - Same for the height.
 * @property {boolean} [resizeEnabled=true] - Forward container size changes to Qt.
 * @property {boolean} [hotReload=false] - Patch the running scene in place in `loadProject()` when the instance's service allows it.
 */

/**
 * Configuration for {@link QmlRuntime}: the instance options plus the viewer
 * options, without `container`, which is the constructor argument.
 * `hotReload` both starts the service on the instance and enables its use on
 * the viewer.
 * @typedef {QmlInstanceConfig & Omit<QmlViewerConfig, 'container'>} QmlRuntimeConfig
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
 * apply to the whole process. Hosts one or more {@link QmlViewer} views.
 *
 * Every option except `colorScheme` is fixed once the instance is loaded. To
 * change one, create a new instance; {@link QmlRuntime} does this for you.
 *
 * ```js
 * const instance = new QmlInstance({ controlsStyle: 'Material' });
 * const a = new QmlViewer(instance, { container: containerA });
 * const b = new QmlViewer(instance, { container: containerB });
 * await Promise.all([a.load(), b.load()]);
 * ```
 *
 * Views on one instance share its filesystem, Controls style and color
 * scheme.
 *
 * Events, connected with {@link QmlInstance.on | on}:
 *
 * | Event | Detail | When |
 * |---|---|---|
 * | `loading` | none | {@link QmlInstance.load | load} started |
 * | `ready` | {@link QmlReady} | The process is running |
 * | `error` | {@link QmlIssue} | {@link QmlInstance.load | load} failed |
 */
class QmlInstance extends EventTarget {
    /** @param {QmlInstanceConfig} [config] */
    constructor(config = {}) {
        super();
        const {
            mode = 'static',
            module = null,
            environment = {},
            loggingRules = '',
            controlsStyle = '',
            colorScheme = '',
            hotReload = false,
            accessibility = false,
        } = config;

        this._mode = buildModes[mode] ? mode : 'static';
        this._module = module;
        this._environment = environment;
        this._loggingRules = loggingRules;
        this._controlsStyle = controlsStyle;
        this._colorScheme = colorScheme;
        this._hotReload = hotReload;
        this._accessibility = accessibility;

        const modeConfig = buildModes[this._mode];
        // Two forms of the same directory: _basePath is resolved against this
        // module (import specifiers), _assetBase against the page (fetches).
        this._basePath = modeConfig.basePath;
        this._assetBase = assetBaseFor(modeConfig.basePath);
        this._shared = modeConfig.shared;

        this._em = null;                // the emscripten module instance
        this._ready = false;
        this._loadPromise = null;
        this._loadStartTime = null;
        this._views = new Map();        // preview id -> QmlViewer (for callback demux)
        this._hotReloadAvailable = false;
        this._previewSink = null;       // view with a hot reload in flight
        this._lastPreviewView = null;   // ... or the last one that had

        console.log(`[qmlinstance] creating instance (mode=${this._mode})`);
    }

    /** Build mode. @type {'static'|'shared'} */
    get mode() { return this._mode; }

    /** Pre-compiled main module, or `null` to fetch and compile on load. @type {WebAssembly.Module|Promise<WebAssembly.Module>|null} */
    get module() { return this._module; }

    /** Environment variables added to the Qt process. @type {Record<string, string>} */
    get environment() { return this._environment; }

    /** Qt logging rules, one per line. @type {string} */
    get loggingRules() { return this._loggingRules; }

    /** Qt Quick Controls style. Empty for the build's default. @type {string} */
    get controlsStyle() { return this._controlsStyle; }

    /** Whether the QmlPreview service is started with the process. @type {boolean} */
    get hotReload() { return this._hotReload; }

    /** Whether the scene is exposed to screen readers. @type {boolean} */
    get accessibility() { return this._accessibility; }

    /**
     * `true` once the QmlPreview service has confirmed in-place updates.
     * Requires `hotReload: true`; set during {@link load}.
     * @type {boolean}
     */
    get hotReloadAvailable() { return this._hotReloadAvailable; }

    /** `true` from {@link load} resolving until {@link destroy}. @type {boolean} */
    get ready() { return this._ready; }

    /** Version of the loaded Qt. Empty until {@link load} resolves. @type {string} */
    get qtVersion() { return this._em ? this._em.getQtVersion() : ''; }

    /**
     * Forced color scheme for every view on this instance. `auto` or empty
     * follows the system. Can be changed at any time.
     * @type {'light'|'dark'|'auto'|''}
     */
    get colorScheme() { return this._colorScheme; }
    set colorScheme(scheme) {
        this._colorScheme = scheme;
        if (this._em)
            this._em.setColorScheme(scheme || 'auto');
    }

    /**
     * Loads and starts the Qt process. Every call returns the same promise, so
     * views sharing an instance load it once. Emits `loading` first and
     * `ready` on success. On failure emits `error` and rejects.
     * @returns {Promise<void>}
     */
    load() {
        if (!this._loadPromise) {
            this._loadStartTime = performance.now();
            this._emit('loading');
            this._loadPromise = this._load().then(() => {
                this._ready = true;
                this._emit('ready', { loadTime: performance.now() - this._loadStartTime,
                                      qtVersion: this.qtVersion });
            }, (e) => {
                this._emit('error', { line: 0, column: 0, message: e.message });
                throw e;
            });
        }
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
        if (this._loggingRules)
            env.QT_LOGGING_RULES = this._loggingRules.split('\n').map(s => s.trim()).filter(Boolean).join(';');
        if (this._controlsStyle)
            env.QT_QUICK_CONTROLS_STYLE = this._controlsStyle;
        if (this._accessibility)
            env.QT_WASM_ENABLE_ACCESSIBILITY = '1';
        Object.assign(env, this._environment);
        if (Object.keys(env).length > 0)
            qtConfig.environment = env;

        if (this._module)
            qtConfig.module = this._module;

        this._em = await qtLoad({
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
        this._em.setOnError((id, line, column, message) =>
            this._views.get(id)?._emit('error', { line, column, message }));
        this._em.setOnWarning((id, line, column, message) =>
            this._views.get(id)?._emit('warning', { line, column, message }));
        this._em.setOnLoaded((id) =>
            this._views.get(id)?._onLoaded());

        // Force the color scheme (process-global), before any view loads QML.
        if (this._colorScheme)
            this._em.setColorScheme(this._colorScheme);

        // Before any view: engines register with the service when created.
        if (this._hotReload)
            this._startHotReload();
    }

    /**
     * Releases the instance. Destroy its views first. The wasm memory is
     * reclaimed by the garbage collector once nothing references it.
     */
    destroy() {
        // No clean wasm teardown; drop references and let GC reclaim once all
        // views are gone. Views call _removeView before this.
        this._em = null;
        this._ready = false;
        this._loadPromise = null;
        this._views.clear();
    }

    // --- hot reload (QmlPreview service) ---

    // Start the in-process QmlPreview service and ask for in-place updates.
    // The Confirmation arrives synchronously and sets `_hotReloadAvailable`.
    _startHotReload() {
        this._em.setOnPreviewMessage((type, payload) => this._onPreviewMessage(type, payload));
        if (!this._em.startPreviewService()) {
            console.warn('[qmlinstance] hot reload unavailable: QmlPreview service did not start');
            return;
        }
        this._em.previewConfigure(true);
        if (!this._hotReloadAvailable)
            console.warn('[qmlinstance] hot reload unavailable: in-place updates not confirmed');
    }

    _onPreviewMessage(type, payload) {
        switch (type) {
        case 'confirmation':
            this._hotReloadAvailable = payload === 'true';
            console.log(`[qmlinstance] hot reload ${this._hotReloadAvailable ? 'enabled' : 'declined by the service'}`);
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

    _previewSendFile(path, contents) { this._em.previewSendFile(path, contents); }
    _previewLoad(url)                { this._em.previewLoad(url); }
    _previewClearCache()             { this._em.previewClearCache(); }

    // --- view lifecycle / ops, used by QmlViewer ---

    _addView(container, view) {
        // Add a screen for this container, then create the view on it (the
        // C++ side binds the new window to the most recently added screen).
        this._em.qtAddContainerElement(container);
        const id = this._em.createPreview();
        this._views.set(id, view);
        return id;
    }

    _removeView(id, container) {
        if (!this._em) return;
        this._em.destroyPreview(id);
        this._em.qtRemoveContainerElement(container);
        this._views.delete(id);
    }

    _loadQml(id, source)        { this._em.loadQml(id, source); }
    _loadEntryFile(id, path)    { this._em.loadEntryFile(id, path); }
    _clearContent(id)           { this._em.clearContent(id); }
    _setSizeMode(id, fw, fh)    { this._em.setSizeMode(id, !!fw, !!fh); }
    _getErrors(id)              { return this._em.getErrors(id); }
    _refreshRoot(id)            { return JSON.parse(this._em.refreshRoot(id)); }
    _resize(container)          { this._em.qtResizeContainerElement(container); }
    _fs()                       { return this._em?.FS; }

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

/**
 * A QML view: a QML engine and window rendered into a DOM element, running
 * on a {@link QmlInstance}. Several viewers can share one instance. For a
 * single view, {@link QmlRuntime} manages the instance as well.
 *
 * ```js
 * const viewer = new QmlViewer(instance, { container: document.getElementById('preview') });
 * viewer.on('ready', () => viewer.loadQml('import QtQuick\nRectangle { color: "red" }'));
 * await viewer.load();
 * ```
 *
 * Every option except `container` is a property of the same name and can be
 * changed at any time.
 *
 * QmlViewer provides events for reacting to load state and QML compiler
 * warnings and errors. Connect to each event using the
 * {@link QmlViewer.on | on} method, which passes the event's `detail` to the
 * callback.
 *
 * | Event | Detail | When |
 * |---|---|---|
 * | `loading` | none | {@link QmlViewer.load | load} started |
 * | `ready` | {@link QmlReady} | The view can load QML |
 * | `error` | {@link QmlIssue} | A QML error, or {@link QmlViewer.load | load} failed |
 * | `warning` | {@link QmlIssue} | A QML warning |
 * | `qmlloaded` | {@link QmlLoaded} | A load finished, with or without errors; see {@link QmlViewer.getErrors | getErrors} |
 *
 * A handler for each event:
 *
 * ```js
 * viewer.on('loading', () => console.log('loading Qt'))
 *       .on('ready', ({ loadTime, qtVersion }) => console.log(`Qt ${qtVersion} ready in ${loadTime} ms`))
 *       .on('error', ({ line, column, message }) => console.error(`${line}:${column}: ${message}`))
 *       .on('warning', ({ line, column, message }) => console.warn(`${line}:${column}: ${message}`))
 *       .on('qmlloaded', ({ hot }) => console.log(hot ? 'hot reloaded' : 'loaded', viewer.getErrors()));
 * ```
 */
class QmlViewer extends EventTarget {
    /**
     * @param {QmlInstance} instance - Instance to render on. {@link load} loads it if needed.
     * @param {QmlViewerConfig} config
     */
    constructor(instance, config = {}) {
        super();
        const {
            container,
            fillWidth = true,
            fillHeight = true,
            resizeEnabled = true,
            hotReload = false,
        } = config;
        if (!instance) throw new Error('QmlViewer: instance is required');
        if (!container) throw new Error('QmlViewer: config.container is required');

        this._instance = instance;
        this._container = container;
        this._fillWidth = !!fillWidth;
        this._fillHeight = !!fillHeight;
        this._resizeEnabled = !!resizeEnabled;
        this._hotReload = !!hotReload;

        this._id = null;
        this._ready = false;
        this._destroyed = false;
        this._loadStartTime = null;
        this._projectRoot = null;       // where loadProject() writes this view's files
        this._resizeObserver = null;
        this._pendingResize = false;
        this._lastLoad = null;          // { entry, files, ok, hot } of the last loadProject
        this._lastRoot = null;          // root state after the last usable load (health baseline)
        this._hotErrors = [];           // errors of the last hot reload
        this._hotMessages = null;       // collects service messages while one is in flight
    }

    /** The instance this view runs on. @type {QmlInstance} */
    get instance() { return this._instance; }

    /** Element the view renders into. @type {HTMLElement} */
    get container() { return this._container; }

    /** `true` from {@link load} resolving until {@link destroy}. @type {boolean} */
    get ready() { return this._ready; }

    /**
     * Stretch the root item to the window width. When `false` the root keeps
     * its implicit width and is centered.
     * @type {boolean}
     */
    get fillWidth() { return this._fillWidth; }
    set fillWidth(fill) {
        this._fillWidth = !!fill;
        this._applySizeMode();
    }

    /** Same as {@link fillWidth}, for the height. @type {boolean} */
    get fillHeight() { return this._fillHeight; }
    set fillHeight(fill) {
        this._fillHeight = !!fill;
        this._applySizeMode();
    }

    _applySizeMode() {
        if (this._ready)
            this._instance._setSizeMode(this._id, this._fillWidth, this._fillHeight);
    }

    /**
     * Forward container size changes to Qt. While `false` the canvas keeps
     * its backing store and is stretched by CSS, which avoids flicker during
     * a splitter drag. Setting it back to `true` applies a pending resize.
     * @type {boolean}
     */
    get resizeEnabled() { return this._resizeEnabled; }
    set resizeEnabled(enabled) {
        enabled = !!enabled;
        if (this._resizeEnabled === enabled) return;
        this._resizeEnabled = enabled;
        if (enabled && this._pendingResize && this._ready) {
            this._instance._resize(this._container);
            this._pendingResize = false;
        }
    }

    /**
     * Patch the running scene in place in {@link loadProject} when only file
     * contents changed. Effective when the instance's
     * {@link QmlInstance.hotReloadAvailable | hotReloadAvailable} is `true`.
     * @type {boolean}
     */
    get hotReload() { return this._hotReload; }
    set hotReload(on) { this._hotReload = !!on; }

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
            await this._instance.load();
            if (this._destroyed) return;

            // Create this view (adds a screen for our container + a window).
            this._id = this._instance._addView(this._container, this);
            // Where loadProject() writes this view's files. Per view, since
            // views sharing an instance share one filesystem — and documents
            // are addressed by URL, so two views must not load different
            // documents from the same path.
            this._projectRoot = `/projects/${this._id}`;
            if (!this._fillWidth || !this._fillHeight)
                this._instance._setSizeMode(this._id, this._fillWidth, this._fillHeight);

            // Notify Qt of container size changes. When resize is disabled
            // (e.g. during an active splitter drag) we remember that a resize
            // is pending but don't forward it — leaving the canvas backing
            // buffer at its current size avoids the WebGL buffer-clear flash.
            this._resizeObserver = new ResizeObserver(() => {
                if (!this._resizeEnabled) {
                    this._pendingResize = true;
                    return;
                }
                this._instance._resize(this._container);
            });
            this._resizeObserver.observe(this._container);

            this._ready = true;
            this._emit('ready', { loadTime: performance.now() - this._loadStartTime,
                                  qtVersion: this._instance.qtVersion });
        } catch (e) {
            this._emit('error', { line: 0, column: 0, message: e.message });
            throw e;
        }
    }

    /**
     * Destroys the view: removes its window and project files and empties
     * {@link container}. The instance keeps running.
     */
    destroy() {
        this._destroyed = true;
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._id != null) {
            try {
                if (this._lastLoad)
                    removeTree(this._instance._fs(), this._projectRoot);
                this._instance._removeView(this._id, this._container);
            } catch (e) { /* ignore cleanup errors */ }
        }
        this._id = null;
        this._ready = false;

        while (this._container.firstChild)
            this._container.removeChild(this._container.firstChild);
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
        if (!this._ready) throw new Error('QmlViewer not ready');
        this._lastLoad = null;   // a setData() document has no URL to hot reload
        this._instance._loadQml(this._id, source);
    }

    /**
     * Loads a project: writes its files to the in-memory filesystem, in a
     * directory private to this view, and loads the entry file from there.
     * Imports between files, `qmldir` and relative URLs resolve as on disk.
     *
     * When {@link hotReload} and the instance's
     * {@link QmlInstance.hotReloadAvailable | hotReloadAvailable} are both
     * `true` and the project differs from the previous load only in file
     * contents, the changed documents are recompiled and patched into the
     * running scene, and live objects keep their state. Everything else is a
     * full load: the first load, a different entry file, added or removed
     * files, an unchanged project, or a patch the service rejects. The
     * `qmlloaded` detail tells which happened.
     * @param {import('./qmlproject.js').QmlProject} project
     * @throws {Error} When called before `ready`.
     */
    loadProject(project) {
        if (!this._ready) throw new Error('QmlViewer not ready');
        const FS = this._instance._fs();
        if (!FS) throw new Error('Emscripten FS not exported from wasm');

        const root = this._projectRoot;
        if (this._hotReloadProject(project, FS, root))
            return;

        // Full load. Contents pushed to the service shadow the filesystem;
        // drop them so the type loader reads what we write below.
        if (this._instance.hotReloadAvailable)
            this._instance._previewClearCache();
        project.writeTo(FS, root);
        this._lastLoad = { entry: project.entry, files: snapshotFiles(project), ok: false, hot: false };
        this._hotErrors = [];
        this._instance._loadEntryFile(this._id, `${root}/${project.entry}`);
    }

    // The in-place path of loadProject(). Returns false when a full load is
    // needed instead.
    _hotReloadProject(project, FS, root) {
        if (!this._hotReload || !this._instance.hotReloadAvailable)
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
            console.warn(`[qmlviewer] hot reload failed (${failure.payload}); reloading`);
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
            console.warn('[qmlviewer] hot reload left no usable root; reloading', rootInfo);
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
        console.log('[qmlviewer] hot reloaded', changed.join(', '), `${elapsed.toFixed(1)}ms`, rootInfo);
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
            console.warn(`[qmlviewer] hot reload failed (${payload})`);
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
        if (!this._ready) return [];
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
        if (this._ready)
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
 * libraries), the Qt Quick Controls style, and options for enabling
 * accessibility and hot reloading support.
 *
 * ```js
 * const runtime = new QmlRuntime(container, {
 *     mode: 'shared',
 *     controlsStyle: 'Material',
 *     accessibility: true,
 *     hotReload: true,
 * });
 * ```
 *
 * Every option is also a property of the same name and can be changed at any
 * time. `colorScheme`, `fillWidth`, `fillHeight`, `resizeEnabled` and
 * `hotReload` apply immediately. `mode`, `module`, `environment`,
 * `loggingRules`, `controlsStyle` and `accessibility` need a new Qt process:
 * the runtime recreates its instance, emits `loading` and `ready` again and
 * re-runs the last loaded QML. Changes made in one go cause one reload, and
 * {@link QmlRuntime.load | load} returns the promise of the reload in flight.
 *
 * ```js
 * runtime.controlsStyle = 'Fusion';
 * runtime.mode = 'shared';
 * await runtime.load();   // one reload; the previous QML is running again
 * ```
 *
 * Each QmlRuntime runs on a {@link QmlInstance}, which manages the
 * WebAssembly instance, through a {@link QmlViewer}. Use those two directly
 * to run several views on one instance.
 *
 * QmlRuntime provides events for reacting to load state and QML compiler
 * warnings and errors. Connect to each event using the
 * {@link QmlRuntime.on | on} method, which passes the event's `detail` to the
 * callback.
 *
 * | Event | Detail | When |
 * |---|---|---|
 * | `loading` | none | A load or reload started |
 * | `ready` | {@link QmlReady} | The view can load QML |
 * | `error` | {@link QmlIssue} | A QML error, or a load failed |
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
        if (!container) throw new Error('QmlRuntime: container is required');
        this._container = container;
        this._config = {
            mode: config.mode ?? 'static',
            module: config.module ?? null,
            environment: config.environment ?? {},
            loggingRules: config.loggingRules ?? '',
            controlsStyle: config.controlsStyle ?? '',
            colorScheme: config.colorScheme ?? '',
            hotReload: config.hotReload ?? false,
            accessibility: config.accessibility ?? false,
            fillWidth: config.fillWidth ?? true,
            fillHeight: config.fillHeight ?? true,
            resizeEnabled: config.resizeEnabled ?? true,
        };
        this._instance = null;
        this._viewer = null;
        this._loadPromise = null;
        this._reloadPending = false;
        this._content = null;           // last loadQml/loadProject, re-run after a reload
        this._contentGeneration = 0;
    }

    /** Element the view renders into. @type {HTMLElement} */
    get container() { return this._container; }

    /** The current instance. `null` before {@link load} and while reloading. @type {?QmlInstance} */
    get instance() { return this._instance; }

    /** The current viewer. `null` before {@link load} and while reloading. @type {?QmlViewer} */
    get viewer() { return this._viewer; }

    /** `true` while the view can load QML: after {@link load}, except during a reload. @type {boolean} */
    get ready() { return !!this._viewer?.ready; }

    /** Version of the loaded Qt. Empty until ready. @type {string} */
    get qtVersion() { return this._instance?.qtVersion ?? ''; }

    /** `true` when the instance's QmlPreview service accepts in-place updates. @type {boolean} */
    get hotReloadAvailable() { return !!this._instance?.hotReloadAvailable; }

    // --- process-level options: a change reloads the instance ---

    /** Build mode. A change reloads. @type {'static'|'shared'} */
    get mode() { return this._config.mode; }
    set mode(mode) { this._setProcessOption('mode', mode); }

    /** Pre-compiled main module, or `null` to fetch and compile on load. A change reloads. @type {WebAssembly.Module|Promise<WebAssembly.Module>|null} */
    get module() { return this._config.module; }
    set module(module) { this._setProcessOption('module', module); }

    /** Environment variables for the Qt process. A change reloads. @type {Record<string, string>} */
    get environment() { return this._config.environment; }
    set environment(environment) { this._setProcessOption('environment', environment); }

    /** Qt logging rules, one per line. A change reloads. @type {string} */
    get loggingRules() { return this._config.loggingRules; }
    set loggingRules(rules) { this._setProcessOption('loggingRules', rules); }

    /** Qt Quick Controls style. Empty for the build's default. A change reloads. @type {string} */
    get controlsStyle() { return this._config.controlsStyle; }
    set controlsStyle(style) { this._setProcessOption('controlsStyle', style); }

    /** Expose the scene to screen readers. A change reloads. @type {boolean} */
    get accessibility() { return this._config.accessibility; }
    set accessibility(on) { this._setProcessOption('accessibility', !!on); }

    _setProcessOption(key, value) {
        if (this._config[key] === value) return;
        this._config[key] = value;
        this._scheduleReload();
    }

    // --- view-level options: apply immediately ---

    /** Forced color scheme. `auto` or empty follows the system. @type {'light'|'dark'|'auto'|''} */
    get colorScheme() { return this._config.colorScheme; }
    set colorScheme(scheme) {
        this._config.colorScheme = scheme;
        if (this._instance) this._instance.colorScheme = scheme;
    }

    /** Stretch the root item to the window width; otherwise keep its implicit width and center it. @type {boolean} */
    get fillWidth() { return this._config.fillWidth; }
    set fillWidth(fill) {
        this._config.fillWidth = !!fill;
        if (this._viewer) this._viewer.fillWidth = fill;
    }

    /** Same as {@link fillWidth}, for the height. @type {boolean} */
    get fillHeight() { return this._config.fillHeight; }
    set fillHeight(fill) {
        this._config.fillHeight = !!fill;
        if (this._viewer) this._viewer.fillHeight = fill;
    }

    /** Forward container size changes to Qt; see {@link QmlViewer.resizeEnabled}. @type {boolean} */
    get resizeEnabled() { return this._config.resizeEnabled; }
    set resizeEnabled(enabled) {
        this._config.resizeEnabled = !!enabled;
        if (this._viewer) this._viewer.resizeEnabled = enabled;
    }

    /**
     * Patch the running scene in place in {@link loadProject} when only file
     * contents changed. Turning it on reloads if the instance was started
     * without the QmlPreview service.
     * @type {boolean}
     */
    get hotReload() { return this._config.hotReload; }
    set hotReload(on) {
        on = !!on;
        this._config.hotReload = on;
        if (this._viewer) this._viewer.hotReload = on;
        if (on && this._instance && !this._instance.hotReload)
            this._scheduleReload();
    }

    /**
     * Loads the runtime, or returns the promise of the load or reload in
     * flight. Emits `loading` first and `ready` on success. On failure emits
     * `error` and rejects.
     * @returns {Promise<void>}
     */
    load() {
        if (!this._loadPromise)
            this._loadPromise = this._start();
        return this._loadPromise;
    }

    /**
     * Destroys the runtime: the view, its project files and the instance.
     * {@link container} is emptied.
     */
    destroy() {
        this._teardown();
        this._loadPromise = null;
        this._reloadPending = false;
        this._content = null;
    }

    /**
     * Loads a QML document from a string, replacing the current scene; see
     * {@link QmlViewer.loadQml}.
     * @param {string} source - QML source.
     * @throws {Error} When called before `ready`.
     */
    loadQml(source) {
        const viewer = this._requireReady();
        this._content = { qml: source };
        this._contentGeneration++;
        viewer.loadQml(source);
    }

    /**
     * Loads a project, in place when hot reload applies; see
     * {@link QmlViewer.loadProject}.
     * @param {import('./qmlproject.js').QmlProject} project
     * @throws {Error} When called before `ready`.
     */
    loadProject(project) {
        const viewer = this._requireReady();
        this._content = { project };
        this._contentGeneration++;
        viewer.loadProject(project);
    }

    /**
     * Returns the errors and warnings of the last load. Empty when not ready.
     * @returns {QmlIssue[]}
     */
    getErrors() { return this._viewer?.getErrors() ?? []; }

    /** Removes the loaded scene. */
    clear() {
        this._content = null;
        this._contentGeneration++;
        this._viewer?.clear();
    }

    _requireReady() {
        if (!this.ready) throw new Error('QmlRuntime not ready');
        return this._viewer;
    }

    async _start() {
        const c = this._config;
        this._instance = new QmlInstance({
            mode: c.mode, module: c.module, environment: c.environment,
            loggingRules: c.loggingRules, controlsStyle: c.controlsStyle,
            colorScheme: c.colorScheme, hotReload: c.hotReload, accessibility: c.accessibility,
        });
        this._viewer = new QmlViewer(this._instance, {
            container: this._container, fillWidth: c.fillWidth, fillHeight: c.fillHeight,
            resizeEnabled: c.resizeEnabled, hotReload: c.hotReload,
        });
        for (const type of ['loading', 'error', 'warning', 'qmlloaded'])
            this._viewer.on(type, (detail) => this._emit(type, detail));
        this._viewer.on('ready', (detail) => {
            const generation = this._contentGeneration;
            this._emit('ready', detail);
            // Re-run what was loaded before a reload, unless a ready handler
            // loaded something itself.
            if (this._content && generation === this._contentGeneration)
                this._run(this._content);
        });
        await this._viewer.load();
    }

    _run(content) {
        if (content.project)
            this._viewer.loadProject(content.project);
        else
            this._viewer.loadQml(content.qml);
    }

    // Recreate instance and viewer once the load in flight has settled. One
    // reload covers all property changes made before it starts.
    _scheduleReload() {
        if (!this._loadPromise || this._reloadPending) return;
        this._reloadPending = true;
        this._loadPromise = this._loadPromise.catch(() => {}).then(() => {
            this._reloadPending = false;
            this._teardown();
            return this._start();
        });
    }

    _teardown() {
        this._viewer?.destroy();
        this._viewer = null;
        this._instance?.destroy();
        this._instance = null;
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

export { QmlInstance, QmlViewer, QmlRuntime };
