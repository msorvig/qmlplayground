// QmlEditor — CodeMirror-backed QML editor shared by the playground and the
// component viewer. Owns the CodeMirror instance, the QML language mode, theme
// selection, and error/warning markers. Emits 'change' on user edits (silent
// during setValue with { silent: true }) and 'run' on Ctrl/Cmd+Enter.
//
// Two modes, since the two front-ends want different chrome:
//
//   'full'     The playground's editor pane: line numbers, a gutter carrying
//              error dots, bracket matching, Ctrl/Cmd+Enter to run.
//   'snippet'  An inline sample in a doc page: no gutter, no line numbers,
//              grows to fit its content, and reports errors by tinting the
//              line plus a hover overlay (the host page has no gutter CSS).
//
// Individual options override the mode's defaults.

// Load CodeMirror once, as a global script. Resolved relative to this module
// rather than the page, so it works from a page at any directory depth.
async function loadCodeMirror() {
    if (typeof CodeMirror !== 'undefined') return;
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = new URL('./codemirror.min.js', import.meta.url).href;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// Register QML mode for CodeMirror. Guarded so loading several editors on one
// page is harmless.
function registerQmlMode() {
    if (CodeMirror.modes.qml) return;

    CodeMirror.defineMode("qml", function() {
        const keywords = [
            "import", "as", "on", "property", "alias", "signal", "readonly",
            "default", "required", "component"
        ];
        const jsKeywords = [
            "var", "let", "const", "function", "return", "if", "else", "for",
            "while", "do", "switch", "case", "break", "continue", "try",
            "catch", "finally", "throw", "new", "typeof", "instanceof", "in",
            "true", "false", "null", "undefined", "this"
        ];
        const types = [
            "int", "real", "double", "string", "bool", "var", "url", "color",
            "date", "point", "size", "rect", "list", "variant"
        ];
        const qmlTypes = [
            "Item", "Rectangle", "Text", "Image", "MouseArea", "Column", "Row",
            "Grid", "Flow", "ListView", "GridView", "Repeater", "Loader",
            "Component", "Timer", "Animation", "PropertyAnimation",
            "NumberAnimation", "ColorAnimation", "RotationAnimation",
            "SequentialAnimation", "ParallelAnimation", "Behavior",
            "State", "Transition", "Canvas", "Window", "ApplicationWindow"
        ];

        function tokenBase(stream, state) {
            const ch = stream.peek();
            if (ch === "/") {
                stream.next();
                if (stream.eat("/")) { stream.skipToEnd(); return "comment"; }
                if (stream.eat("*")) { state.tokenize = tokenComment; return tokenComment(stream, state); }
                stream.backUp(1);
            }
            if (ch === '"' || ch === "'") {
                stream.next();
                state.tokenize = tokenString(ch);
                return state.tokenize(stream, state);
            }
            if (/\d/.test(ch)) {
                stream.match(/^\d*\.?\d*([eE][+-]?\d+)?/);
                return "number";
            }
            if (/[\w_]/.test(ch)) {
                stream.match(/^[\w_]+/);
                const word = stream.current();
                if (keywords.includes(word)) return "keyword";
                if (jsKeywords.includes(word)) return "keyword";
                if (types.includes(word)) return "type";
                if (qmlTypes.includes(word)) return "type";
                if (/^[A-Z]/.test(word)) return "type";
                if (stream.peek() === ':') return "property";
                return "variable";
            }
            if (/[+\-*/%=<>!&|^~?:]/.test(ch)) { stream.next(); return "operator"; }
            if (/[{}\[\]()]/.test(ch)) { stream.next(); return "bracket"; }
            stream.next();
            return null;
        }

        function tokenString(quote) {
            return function(stream, state) {
                let escaped = false, ch;
                while ((ch = stream.next()) != null) {
                    if (ch === quote && !escaped) { state.tokenize = tokenBase; break; }
                    escaped = !escaped && ch === "\\";
                }
                return "string";
            };
        }

        function tokenComment(stream, state) {
            let ch;
            while ((ch = stream.next()) != null) {
                if (ch === "*" && stream.eat("/")) { state.tokenize = tokenBase; break; }
            }
            return "comment";
        }

        return {
            startState: () => ({ tokenize: tokenBase }),
            token: (stream, state) => stream.eatSpace() ? null : state.tokenize(stream, state),
            lineComment: "//",
            blockCommentStart: "/*",
            blockCommentEnd: "*/"
        };
    });
    CodeMirror.defineMIME("text/x-qml", "qml");
}

function cmThemeFor(resolvedTheme) {
    return resolvedTheme === 'light' ? 'default' : 'gruvbox-dark';
}

// Trim a leading/trailing blank line and strip common leading indentation, so
// samples authored inside indented HTML display flush-left.
function dedent(source) {
    const lines = source.replace(/\t/g, '    ').split('\n');
    while (lines.length && lines[0].trim() === '') lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    const indents = lines.filter(l => l.trim() !== '')
                         .map(l => l.match(/^ */)[0].length);
    const min = indents.length ? Math.min(...indents) : 0;
    return lines.map(l => l.slice(min)).join('\n');
}

const editorModes = {
    full: {
        theme: 'dark',
        lineNumbers: true,
        gutter: true,
        tooltip: 'gutter',
        autoHeight: false,
        autoCloseBrackets: true,
        matchBrackets: true,
        runKey: true,
        dedent: false,
    },
    snippet: {
        theme: 'light',
        lineNumbers: false,
        gutter: false,
        tooltip: 'overlay',
        autoHeight: true,
        autoCloseBrackets: false,
        matchBrackets: false,
        runKey: false,
        dedent: true,
    },
};

class QmlEditor extends EventTarget {
    // `host` is either a <textarea> (replaced in place) or any element the
    // editor is rendered into.
    constructor(host, options = {}) {
        super();
        this.host = host;

        const preset = editorModes[options.mode] ?? editorModes.full;
        this._options = { ...preset, ...options };
        this._theme = this._options.theme;

        const source = this._options.source ?? '';
        this._source = this._options.dedent ? dedent(source) : source;

        this.editor = null;
        this._silent = false;
        this._markers = [];
        this._lineErrors = new Map();   // lineIndex -> message, for the overlay
        this._tooltip = null;
    }

    async init() {
        await loadCodeMirror();
        registerQmlMode();

        const o = this._options;
        const cmOptions = {
            mode: 'qml',
            theme: cmThemeFor(this._theme),
            lineNumbers: o.lineNumbers,
            indentUnit: 4,
            tabSize: 4,
            indentWithTabs: false,
            autoCloseBrackets: o.autoCloseBrackets,
            matchBrackets: o.matchBrackets,
        };
        if (o.gutter)
            cmOptions.gutters = ['CodeMirror-linenumbers', 'error-gutter'];
        if (o.autoHeight) {
            // Render the whole document so CSS `height: auto` on .CodeMirror
            // lets the editor grow to its content with no inner scrollbar.
            cmOptions.viewportMargin = Infinity;
        }
        if (o.runKey) {
            cmOptions.extraKeys = {
                'Ctrl-Enter': () => this._emit('run'),
                'Cmd-Enter': () => this._emit('run'),
            };
        }

        if (this.host.tagName === 'TEXTAREA') {
            if (this._source) this.host.value = this._source;
            this.editor = CodeMirror.fromTextArea(this.host, cmOptions);
        } else {
            this.editor = CodeMirror(this.host, { ...cmOptions, value: this._source });
        }

        this.editor.on('change', () => {
            if (this._silent) return;
            this._emit('change');
        });

        if (o.tooltip === 'overlay')
            this._initTooltip();

        this._emit('ready');
        return this;
    }

    // A single tooltip element parented to <body> (so it escapes CodeMirror's
    // overflow clip), shown while the pointer is over a tinted error line.
    // Used in 'snippet' mode, where there is no gutter to hang a marker off
    // and the host page supplies no tooltip styling.
    _initTooltip() {
        const tip = document.createElement('div');
        tip.className = 'qmleditor-error-tooltip';
        Object.assign(tip.style, {
            position: 'fixed', zIndex: '2000', display: 'none',
            maxWidth: '480px', padding: '6px 10px', borderRadius: '4px',
            background: '#f4f4f4', color: '#222', border: '1px solid #d0d0d0',
            font: '12px/1.4 -apple-system, "Helvetica Neue", Arial, sans-serif',
            whiteSpace: 'pre-wrap', pointerEvents: 'none',
            boxShadow: '0 2px 8px rgba(0,0,0,.15)',
        });
        document.body.appendChild(tip);
        this._tooltip = tip;

        const wrap = this.editor.getWrapperElement();
        wrap.addEventListener('mousemove', (e) => {
            const lineIndex = this.editor.lineAtHeight(e.clientY, 'client');
            const message = this._lineErrors.get(lineIndex);
            if (message == null) { tip.style.display = 'none'; return; }
            tip.textContent = message;
            tip.style.display = 'block';
            tip.style.left = `${Math.min(e.clientX + 8, window.innerWidth - tip.offsetWidth - 8)}px`;
            tip.style.top = `${e.clientY + 16}px`;
        });
        wrap.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    }

    getValue() {
        return this.editor?.getValue() ?? this._source;
    }

    setValue(source, { silent = false } = {}) {
        if (!this.editor) return;
        const prev = this._silent;
        if (silent) this._silent = true;
        this.editor.setValue(source);
        this._silent = prev;
    }

    // Append text at the end of the document via replaceRange so we
    // don't reset the cursor, scroll, or undo history. Used for token
    // streaming. Silent variant suppresses the 'change' event so
    // playground auto-run isn't triggered per token.
    appendValue(text, { silent = false } = {}) {
        if (!this.editor || !text) return;
        const doc = this.editor.getDoc();
        const lastLine = doc.lastLine();
        const lastCh = doc.getLine(lastLine).length;
        const prev = this._silent;
        if (silent) this._silent = true;
        doc.replaceRange(text, { line: lastLine, ch: lastCh });
        this._silent = prev;
    }

    // "Stream over" mode: instead of clearing then appending, write
    // the new tokens over whatever is already in the editor starting
    // at position 0, character by character. Call beginOverwrite()
    // once, overwrite(delta) per token, finalizeOverwrite() at the
    // end to truncate any leftover trailing characters.
    beginOverwrite() {
        this._overwritePos = 0;
    }

    overwrite(delta, { silent = false } = {}) {
        if (!this.editor || !delta) return;
        const doc = this.editor.getDoc();
        const totalLen = doc.getValue().length;
        const start = doc.posFromIndex(this._overwritePos);
        const endIdx = Math.min(this._overwritePos + delta.length, totalLen);
        const end = doc.posFromIndex(endIdx);
        const prev = this._silent;
        if (silent) this._silent = true;
        doc.replaceRange(delta, start, end);
        this._silent = prev;
        this._overwritePos += delta.length;
    }

    finalizeOverwrite({ silent = false } = {}) {
        if (!this.editor) return;
        const doc = this.editor.getDoc();
        const totalLen = doc.getValue().length;
        if (this._overwritePos >= totalLen) return;
        const start = doc.posFromIndex(this._overwritePos);
        const end = doc.posFromIndex(totalLen);
        const prev = this._silent;
        if (silent) this._silent = true;
        doc.replaceRange('', start, end);
        this._silent = prev;
    }

    focus()    { this.editor?.focus(); }
    hasFocus() { return !!this.editor && this.editor.hasFocus(); }
    refresh()  { this.editor?.refresh(); }

    setTheme(resolvedTheme) {
        this._theme = resolvedTheme;
        this.editor?.setOption('theme', cmThemeFor(resolvedTheme));
    }

    // Tear down: CodeMirror has no formal dispose, so drop the instance and
    // empty the host element (removes the rendered editor DOM).
    destroy() {
        this.editor = null;
        this._tooltip?.remove();
        this._tooltip = null;
        while (this.host.firstChild) this.host.removeChild(this.host.firstChild);
    }

    // Mark a 1-based line as carrying an error or warning: a full-width tinted
    // bar, plus either a gutter dot whose CSS shows `message` on hover
    // ('gutter') or a body-level overlay shown on hover ('overlay'). Lines off
    // the document — e.g. an error mapped into a snippet's hidden preamble —
    // are skipped.
    addMarker(line, column, message, type = 'error') {
        if (!this.editor || line <= 0) return;
        const lineIndex = line - 1;
        if (lineIndex > this.editor.lastLine()) return;

        const bgClass = type === 'warning' ? 'warning-line-bg' : 'error-line-bg';
        this.editor.addLineClass(lineIndex, 'background', bgClass);

        if (this._options.gutter) {
            const marker = document.createElement('div');
            marker.className = type === 'warning' ? 'warning-marker' : 'error-marker';
            marker.innerHTML = '●';
            marker.setAttribute('data-tooltip', message);
            this.editor.setGutterMarker(lineIndex, 'error-gutter', marker);
        }
        if (this._options.tooltip === 'overlay')
            this._lineErrors.set(lineIndex, message);

        this._markers.push({ line: lineIndex, bgClass });
    }

    clearMarkers() {
        if (!this.editor) return;
        for (const m of this._markers) {
            if (this._options.gutter)
                this.editor.setGutterMarker(m.line, 'error-gutter', null);
            this.editor.removeLineClass(m.line, 'background', m.bgClass);
        }
        this._markers = [];
        this._lineErrors.clear();
        if (this._tooltip) this._tooltip.style.display = 'none';
    }

    _emit(type, detail = {}) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    on(event, callback) {
        this.addEventListener(event, (e) => callback(e.detail));
        return this;
    }
}

export { QmlEditor, dedent };
