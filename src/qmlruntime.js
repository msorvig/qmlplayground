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

            // Set up resize observer to notify Qt of container size changes
            // TODO: repaint during resize not working - investigate RAF callbacks
            this._resizeObserver = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    this.instance.qtResizeAllScreens(entry);
                }
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
        this._clearDir(FS, root);
        this._mkdirP(FS, root);

        for (const file of project.files.values()) {
            const fullPath = `${root}/${file.path}`;
            const lastSlash = fullPath.lastIndexOf('/');
            if (lastSlash > 0) this._mkdirP(FS, fullPath.slice(0, lastSlash));

            const data = file.encoding === 'base64'
                ? Uint8Array.from(atob(file.content), c => c.charCodeAt(0))
                : file.content;
            FS.writeFile(fullPath, data);
        }

        this.instance.loadEntryFile(`${root}/${project.entry}`);
    }

    _mkdirP(FS, dirPath) {
        const parts = dirPath.split('/').filter(Boolean);
        let acc = '';
        for (const p of parts) {
            acc += '/' + p;
            try { FS.mkdir(acc); } catch (_) { /* exists */ }
        }
    }

    _clearDir(FS, root) {
        let entries;
        try { entries = FS.readdir(root); } catch (_) { return; }
        for (const e of entries) {
            if (e === '.' || e === '..') continue;
            const full = `${root}/${e}`;
            try {
                const stat = FS.stat(full);
                if (FS.isDir(stat.mode)) {
                    this._clearDir(FS, full);
                    FS.rmdir(full);
                } else {
                    FS.unlink(full);
                }
            } catch (_) { /* ignore */ }
        }
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
