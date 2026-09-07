// QmlProject — in-memory model of a (potentially) multi-file QML project.
//
// Holds files keyed by path, plus a designated entry file that the runtime
// loads. Emits events when files change so the playground can re-run.
// JSON serialisation follows the v1 schema described in PLAN_PROJECTS.md.

const SCHEMA = 'qmlplayground/project/v1';

function makeId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID)
        return crypto.randomUUID();
    return 'proj-' + Math.random().toString(36).slice(2, 10);
}

class QmlProject extends EventTarget {
    constructor(options = {}) {
        super();
        this.id = options.id ?? makeId();
        this.name = options.name ?? 'Untitled';
        this.entry = options.entry ?? 'Main.qml';
        this.qtModules = options.qtModules ?? [];
        this.buildMode = options.buildMode ?? null;
        this.createdAt = options.createdAt ?? new Date().toISOString();
        this.updatedAt = options.updatedAt ?? this.createdAt;
        this.files = new Map();

        const seed = options.files ?? [{ path: this.entry, content: '' }];
        for (const f of seed)
            this._addFileInternal(f.path, f.content, f.encoding ?? 'utf-8');
    }

    // ---- File ops ----

    hasFile(path) {
        return this.files.has(path);
    }

    getFile(path) {
        return this.files.get(path);
    }

    getFileContent(path) {
        return this.files.get(path)?.content ?? '';
    }

    setFileContent(path, content) {
        const f = this.files.get(path);
        if (f) {
            if (f.content === content) return;
            f.content = content;
            f.dirty = true;
        } else {
            this._addFileInternal(path, content);
            this._emit('fileadded', { path });
        }
        this._touch();
        this._emit('filechanged', { path });
    }

    addFile(path, content = '') {
        if (this.files.has(path))
            throw new Error(`File already exists: ${path}`);
        this._addFileInternal(path, content);
        this._touch();
        this._emit('fileadded', { path });
    }

    removeFile(path) {
        if (path === this.entry)
            throw new Error('Cannot remove the entry file');
        if (!this.files.delete(path)) return;
        this._touch();
        this._emit('fileremoved', { path });
    }

    renameFile(from, to) {
        if (from === to) return;
        if (!this.files.has(from)) throw new Error(`No such file: ${from}`);
        if (this.files.has(to)) throw new Error(`Destination exists: ${to}`);
        const f = this.files.get(from);
        f.path = to;
        this.files.delete(from);
        this.files.set(to, f);
        if (this.entry === from) this.entry = to;
        this._touch();
        this._emit('filerenamed', { from, to });
    }

    listPaths() {
        return Array.from(this.files.keys());
    }

    setEntry(path) {
        if (!this.files.has(path)) throw new Error(`No such file: ${path}`);
        if (this.entry === path) return;
        this.entry = path;
        this._touch();
        this._emit('entrychanged', { entry: path });
    }

    // ---- Entry-file convenience (single-file flow) ----

    getEntryContent() {
        return this.getFileContent(this.entry);
    }

    setEntryContent(content) {
        this.setFileContent(this.entry, content);
    }

    // ---- JSON I/O (v1 schema) ----

    toJSON() {
        return {
            $schema: SCHEMA,
            id: this.id,
            name: this.name,
            entry: this.entry,
            qtModules: this.qtModules,
            buildMode: this.buildMode,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            files: Array.from(this.files.values()).map(f => ({
                path: f.path,
                encoding: f.encoding,
                content: f.content,
            })),
        };
    }

    // Write every file in this project into an Emscripten-style FS
     // (e.g. Module.FS) under `root`. Clears the directory first so
     // stale files from a previous project don't linger. After this
     // call the runtime can load the entry file via the FS path
     // `${root}/${entry}`.
    writeTo(FS, root) {
        clearDir(FS, root);
        mkdirP(FS, root);

        for (const file of this.files.values()) {
            const fullPath = `${root}/${file.path}`;
            const lastSlash = fullPath.lastIndexOf('/');
            if (lastSlash > 0) mkdirP(FS, fullPath.slice(0, lastSlash));

            const data = file.encoding === 'base64'
                ? Uint8Array.from(atob(file.content), c => c.charCodeAt(0))
                : file.content;
            FS.writeFile(fullPath, data);
        }
    }

    static fromJSON(obj) {
        if (!obj || typeof obj !== 'object')
            throw new Error('Project JSON is not an object');
        if (obj.$schema && obj.$schema !== SCHEMA)
            throw new Error(`Unsupported schema: ${obj.$schema}`);
        if (!Array.isArray(obj.files))
            throw new Error('Project JSON is missing files[]');

        return new QmlProject({
            id: obj.id,
            name: obj.name,
            entry: obj.entry,
            qtModules: obj.qtModules,
            buildMode: obj.buildMode,
            createdAt: obj.createdAt,
            updatedAt: obj.updatedAt,
            files: obj.files,
        });
    }

    // ---- Internals ----

    _addFileInternal(path, content, encoding = 'utf-8') {
        this.files.set(path, {
            path,
            type: path.endsWith('.qml') ? 'qml'
                : path === 'qmldir' || path.endsWith('/qmldir') ? 'qmldir'
                : path.endsWith('.js') || path.endsWith('.mjs') ? 'js'
                : 'text',
            encoding,
            content,
            dirty: false,
        });
    }

    _touch() {
        this.updatedAt = new Date().toISOString();
    }

    _emit(type, detail = {}) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    on(event, callback) {
        this.addEventListener(event, (e) => callback(e.detail));
        return this;
    }
}

// Recursively create `dirPath` in the given Emscripten FS, ignoring
// "already exists" errors.
function mkdirP(FS, dirPath) {
    const parts = dirPath.split('/').filter(Boolean);
    let acc = '';
    for (const p of parts) {
        acc += '/' + p;
        try { FS.mkdir(acc); } catch (_) { /* exists */ }
    }
}

// Recursively unlink everything under `root` (files first, then
// directories). Silently does nothing if `root` doesn't exist.
function clearDir(FS, root) {
    let entries;
    try { entries = FS.readdir(root); } catch (_) { return; }
    for (const e of entries) {
        if (e === '.' || e === '..') continue;
        const full = `${root}/${e}`;
        try {
            const stat = FS.stat(full);
            if (FS.isDir(stat.mode)) {
                clearDir(FS, full);
                FS.rmdir(full);
            } else {
                FS.unlink(full);
            }
        } catch (_) { /* ignore */ }
    }
}

export { QmlProject };
