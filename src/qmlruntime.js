// QmlRuntime - JavaScript wrapper for Qt QML WebAssembly runtime

import { qtLoad } from './qtloader.js';
import { qmlruntime_wasm_entry } from './qmlruntime_wasm.js';

class QmlRuntime extends EventTarget {
    constructor(container) {
        super();
        this.container = container;
        this.instance = null;
        this.ready = false;
        this._loadStartTime = null;
    }

    // Load the Qt runtime
    async load() {
        this._loadStartTime = performance.now();
        this._emit('loading');

        try {
            this.instance = await qtLoad({
                locateFile: (path) => path,
                qt: {
                    onLoaded: () => this._emit('qtloaded'),
                    onExit: (data) => this._emit('exit', { data }),
                    entryFunction: qmlruntime_wasm_entry,
                    containerElements: [this.container],
                }
            });

            // Set up callbacks
            this.instance.setOnError((line, column, message) => {
                this._emit('error', { line, column, message });
            });

            this.instance.setOnWarning((line, column, message) => {
                this._emit('warning', { line, column, message });
            });

            this.instance.setOnLoaded(() => {
                this._emit('qmlloaded');
            });

            // Set up resize observer to notify Qt of container size changes
            // TODO: repaint during resize not working - investigate RAF callbacks
            this._resizeObserver = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    this.instance.qtResizeAllScreens();
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

    // Load QML source code
    loadQml(source) {
        if (!this.ready) {
            throw new Error('Runtime not ready');
        }
        this.instance.loadQml(source);
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
