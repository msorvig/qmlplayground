// QmlEditor — CodeMirror-backed QML editor. Owns the CodeMirror instance,
// the QML language mode, theme selection, and gutter/line markers for errors
// and warnings. Emits 'change' on user edits (silent during setValue with
// { silent: true }) and 'run' on Ctrl/Cmd+Enter.

// Load CodeMirror dynamically (single global script load)
async function loadCodeMirror() {
    if (typeof CodeMirror !== 'undefined') return;
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'codemirror.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// Register QML mode for CodeMirror
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

class QmlEditor extends EventTarget {
    constructor(textarea, options = {}) {
        super();
        this.textareaElement = textarea;
        this._theme = options.theme ?? 'dark';
        this.editor = null;
        this._errorMarkers = [];
        this._silent = false;
    }

    async init() {
        await loadCodeMirror();
        registerQmlMode();

        this.editor = CodeMirror.fromTextArea(this.textareaElement, {
            mode: 'qml',
            theme: cmThemeFor(this._theme),
            lineNumbers: true,
            gutters: ['CodeMirror-linenumbers', 'error-gutter'],
            indentUnit: 4,
            tabSize: 4,
            indentWithTabs: false,
            autoCloseBrackets: true,
            matchBrackets: true,
            extraKeys: {
                'Ctrl-Enter': () => this._emit('run'),
                'Cmd-Enter': () => this._emit('run'),
            }
        });

        this.editor.on('change', () => {
            if (this._silent) return;
            this._emit('change');
        });

        this._emit('ready');
    }

    getValue() {
        return this.editor?.getValue() ?? '';
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

    addMarker(line, column, message, type = 'error') {
        if (!this.editor || line <= 0) return;
        const lineIndex = line - 1;
        const marker = document.createElement('div');
        marker.className = type === 'warning' ? 'warning-marker' : 'error-marker';
        marker.innerHTML = '●';
        marker.setAttribute('data-tooltip', message);
        this.editor.setGutterMarker(lineIndex, 'error-gutter', marker);
        const bgClass = type === 'warning' ? 'warning-line-bg' : 'error-line-bg';
        this.editor.addLineClass(lineIndex, 'background', bgClass);
        this._errorMarkers.push({ line: lineIndex, type });
    }

    clearMarkers() {
        if (!this.editor) return;
        for (const item of this._errorMarkers) {
            this.editor.setGutterMarker(item.line, 'error-gutter', null);
            this.editor.removeLineClass(item.line, 'background', 'error-line-bg');
            this.editor.removeLineClass(item.line, 'background', 'warning-line-bg');
        }
        this._errorMarkers = [];
    }

    _emit(type, detail = {}) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    on(event, callback) {
        this.addEventListener(event, (e) => callback(e.detail));
        return this;
    }
}

export { QmlEditor };
