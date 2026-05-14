# QML Playground

A browser-based QML editor and runtime powered by Qt for WebAssembly.

**Try it:** [msorvig.github.io/qmlplayground](https://msorvig.github.io/qmlplayground/)

## Features

- Live QML editing with syntax highlighting
- Auto-run on code changes
- Error and warning display with line markers
- Built-in examples for QtQuick, QtQuick Controls, Qt Quick 3D, and Qt Graphs

## Quick Start

```html
<div id="playground"></div>
<script type="module">
    import { QmlPlayground } from './qmlplayground.js';
    const playground = new QmlPlayground(document.getElementById('playground'));
    await playground.init();
</script>
```

## JavaScript API

### QmlPlayground

Self-contained component that creates its own UI inside a Shadow DOM. Includes the editor, preview pane, toolbar, console, and examples dropdown.

```javascript
import { QmlPlayground } from './qmlplayground.js';

const playground = new QmlPlayground(document.getElementById('container'));

playground
    .on('ready', ({ loadTime }) => console.log(`Ready in ${loadTime}ms`))
    .on('error', ({ line, column, message }) => console.error(message))
    .on('warning', ({ line, column, message }) => console.warn(message))
    .on('success', () => console.log('QML loaded'));

await playground.init();
```

#### Methods

| Method | Description |
|--------|-------------|
| `init()` | Initialize editor and runtime (async) |
| `getValue()` | Get the active editor content |
| `setValue(source)` | Set the active editor content (mirrors into the project's entry file) |
| `run()` | Hand the project to the runtime and run it |
| `refresh()` | Refresh editor layout |
| `getExamples()` | Get loaded examples array |
| `loadExample(name)` | Load example by name or filename (async) |
| `getProject()` | Get the current `QmlProject` (see below) |

#### Events

| Event | Detail | Description |
|-------|--------|-------------|
| `loading` | - | Qt runtime starting to load |
| `ready` | `{ loadTime }` | Runtime ready |
| `running` | - | QML execution started |
| `error` | `{ line, column, message }` | QML compile error |
| `warning` | `{ line, column, message }` | QML runtime warning |
| `success` | - | QML loaded successfully |
| `examplesloaded` | `{ examples }` | Examples index loaded |
| `exampleloaded` | `{ example, source }` | Example file loaded |

### QmlRuntime

Lower-level wrapper for the Qt WebAssembly runtime. Use this when you need just the runtime without the editor.

```javascript
import { QmlRuntime } from './qmlruntime.js';

const runtime = new QmlRuntime(document.getElementById('container'));

runtime
    .on('ready', ({ loadTime }) => console.log(`Ready in ${loadTime}ms`))
    .on('error', ({ line, column, message }) => console.error(message));

await runtime.load();

runtime.loadQml(`
    import QtQuick
    Rectangle {
        anchors.fill: parent
        color: "steelblue"
    }
`);
```

#### Configuring QmlRuntime

The constructor accepts an optional config object:

```javascript
const runtime = new QmlRuntime(document.getElementById('container'), {
    mode: 'shared',
    loggingRules: 'qt.qml.import.debug=true;qt.qml.pluginloadblob.debug=true',
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `mode` | `'static'` | `'static'` or `'shared'` |
| `loggingRules` | `''` | Qt logging filter rules (semicolon-separated), passed via `QT_LOGGING_RULES` |

#### Loading QML

`loadQml()` starts loading asynchronously. Listen for `qmlloaded` to know when
loading completes (both on success and on error). Use `getErrors()` to check
the result.

```javascript
runtime.on('qmlloaded', () => {
    const issues = runtime.getErrors();
    const errors = issues.filter(i => i.type === 'error');
    if (errors.length > 0)
        console.error('Errors:', errors);
    else
        console.log('QML loaded successfully');
});

runtime.loadQml(`
    import QtQuick
    Rectangle { anchors.fill: parent; color: "steelblue" }
`);
```

With the `shared` build mode, `loadQml()` may trigger on-demand fetching of
QML plugin `.so` files over HTTP. The `qmlloaded` event fires after all
plugins have loaded and types are resolved.

#### Methods

| Method | Description |
|--------|-------------|
| `load()` | Load the Qt runtime (async) |
| `destroy()` | Tear down the runtime and clean up |
| `loadQml(source)` | Load a single-string QML source via `QQmlComponent::setData` |
| `loadProject(project)` | Write a `QmlProject` into Emscripten's MEMFS and load the entry file. Cross-file imports, `qmldir`, and relative URLs resolve through the in-memory filesystem |
| `getErrors()` | Get errors/warnings from last load |
| `clear()` | Clear the QML scene |

#### Events

| Event | Detail | Description |
|-------|--------|-------------|
| `loading` | - | Runtime starting to load |
| `ready` | `{ loadTime, qtVersion }` | Runtime ready, `loadQml` can be called |
| `qmlloaded` | - | QML loading complete (success or error); check `getErrors()` |
| `error` | `{ line, column, message }` | Individual QML error |
| `warning` | `{ line, column, message }` | Individual QML warning |

### QmlEditor

CodeMirror-backed QML editor extracted from `QmlPlayground`. Owns the
CodeMirror instance, the QML language mode, theme selection, and error /
warning gutter markers. Useful if you want a QML editor without the full
playground chrome.

```javascript
import { QmlEditor } from './qmleditor.js';

const textarea = document.querySelector('textarea');
const editor = new QmlEditor(textarea, { theme: 'dark' });
await editor.init();

editor.on('change', () => console.log('user edited:', editor.getValue()));
editor.on('run',    () => console.log('Ctrl/Cmd+Enter pressed'));

editor.setTheme('light');
editor.addMarker(7, 12, 'unknown property', 'warning');
```

#### Methods

| Method | Description |
|--------|-------------|
| `init()` | Async: load CodeMirror, register the QML mode, instantiate |
| `getValue()` / `setValue(s, { silent? })` | Read / write content. `{ silent: true }` skips the `change` event |
| `focus()` / `hasFocus()` | Focus management |
| `refresh()` | Force a CodeMirror layout recalc |
| `setTheme('dark' \| 'light')` | Swap the CodeMirror theme to match the host UI |
| `addMarker(line, column, message, type)` | Place an error / warning marker on a line |
| `clearMarkers()` | Remove all markers |

#### Events

| Event | Description |
|-------|-------------|
| `ready` | Editor instantiated and visible |
| `change` | User edited the content (not fired during silent `setValue`) |
| `run` | User pressed Ctrl/Cmd+Enter |

### QmlProject

In-memory model of a (potentially multi-file) QML project. Holds files keyed
by path, plus a designated `entry` file the runtime loads. JSON
serialisation follows the `qmlplayground/project/v1` schema. `QmlPlayground`
holds one by default (single `Main.qml`); pass it to
`QmlRuntime.loadProject()` to render.

```javascript
import { QmlProject } from './qmlproject.js';

const project = new QmlProject({ entry: 'Main.qml', name: 'Demo' });
project.setFileContent('Main.qml', `import QtQuick\nRectangle { color: "steelblue" }`);
project.addFile('Components/Card.qml', '/* ... */');
project.addFile('qmldir', 'module Components\nCard 1.0 Components/Card.qml\n');

const json = project.toJSON();          // serialise (v1 schema)
const copy = QmlProject.fromJSON(json); // round-trip
```

#### Methods

| Method | Description |
|--------|-------------|
| `hasFile(path)` / `getFile(path)` / `getFileContent(path)` | Inspect files |
| `setFileContent(path, s)` | Update or create a file's content |
| `addFile(path, s?)` / `removeFile(path)` / `renameFile(from, to)` | Tree mutation |
| `listPaths()` | All file paths |
| `setEntry(path)` | Choose which file the runtime loads |
| `getEntryContent()` / `setEntryContent(s)` | Convenience for the entry file |
| `toJSON()` / `QmlProject.fromJSON(obj)` | v1 schema serialise / parse |

#### Events

| Event | Detail | Description |
|-------|--------|-------------|
| `filechanged` | `{ path }` | File content changed |
| `fileadded` / `fileremoved` | `{ path }` | Tree changed |
| `filerenamed` | `{ from, to }` | Rename |
| `entrychanged` | `{ entry }` | Designated entry file changed |

## Build Modes

The playground supports two build modes:

| | Static | Shared |
|---|---|---|
| Linking | All Qt modules in one wasm binary | Core + QML engine; modules loaded on demand |
| Size | Large (~38 MB) | Small initial download; modules fetched as needed |
| Deploy dir | `dist/static/` | `dist/shared/` |

Users can switch between modes at runtime via the Settings dialog (gear icon).
The selection persists in localStorage.

## Building

### Prerequisites

- Qt 6.11+ built for WebAssembly (static or shared)
- Emscripten SDK (matching your Qt build)
- CMake 3.16+

### Using build.sh

Set Qt install paths via environment variables, then run `build.sh`:

```bash
export QT_STATIC_PREFIX=/path/to/qt/wasm/qtbase
export QT_SHARED_PREFIX=/path/to/qt/wasm-shared/qtbase

./build.sh deploy              # build and deploy both static + shared
./build.sh deploy --opt        # also run wasm-opt (slow, smaller output)
./build.sh deploy --copy-qt    # copy Qt libs instead of symlinking (for deployment)
./build.sh static              # build static only
./build.sh shared              # build shared only
./build.sh deploy --clean      # clean build dirs first
```

Either variable can be omitted to skip that variant. By default, the shared
build symlinks to the Qt install. Use `--copy-qt` to make a self-contained
deploy directory that can be uploaded to a server.

### Manual build

```bash
# Static
/path/to/qt-static/bin/qt-cmake -S . -B build-wasm -GNinja
cmake --build build-wasm --target deploy

# Shared
/path/to/qt-shared/bin/qt-cmake -S . -B build-wasm-shared \
    -DQMLPLAYGROUND_SHARED=ON \
    -DQMLPLAYGROUND_QT_PREFIX=/path/to/qt-shared \
    -GNinja
cmake --build build-wasm-shared --target deploy
```

### Deploy layout

```
dist/
  index.html              Web frontend
  qmlplayground.js
  qmleditor.js
  qmlproject.js
  qmlruntime.js
  codemirror.min.js/css
  titillium-web/          Bundled fonts (woff2)
  examples/
  static/                 Static runtime build
    qmlruntime_wasm.js
    qmlruntime_wasm.wasm
    qtloader.js
  shared/                 Shared runtime build
    qmlruntime_wasm.js
    qmlruntime_wasm.wasm
    qtloader.js
    qt.conf
    qt_plugins.json
    qt/                   Symlinks to Qt install
      lib/ -> ...
      plugins/ -> ...
      qml/ -> ...
```

## Project Structure

```
CMakeLists.txt          Build spesification and config
build.sh                Top-level build script for both variants
cmake/
  patch_esm.cmake       qtloader.js ES module patching script
src/
  index.html            Demo page
  main.cpp              C++ entry point
  qmlplayground.js      QmlPlayground component
  qmleditor.js          QmlEditor (CodeMirror wrapper)
  qmlproject.js         QmlProject (multi-file QML project model)
  qmlruntime.js         QmlRuntime component
  qmlruntime.cpp/h      QmlRuntime C++ source
  imports.qml           QML imports for static linking
  qt.conf               Qt prefix config for shared builds
  qt_plugins.json       Platform plugin preload for shared builds
3rdparty/
  codemirror/           CodeMirror editor
  titillium-web/        Bundled Titillium Web font (woff2 + TTF)
examples/
  index.json            Examples index
  *.qml                 Example files
dist/                 Generated output (gitignored)
  static/               Static build wasm files
  shared/               Shared build wasm files + Qt symlinks
```

## Examples Format

Examples are defined in `examples/index.json`:

```json
[
    { "name": "Hello World", "file": "hello.qml" },
    { "name": "Animation", "file": "animation.qml" }
]
```

## Supported Qt Modules

- QtQuick
- QtQuick.Controls
- QtQuick.Layouts
- QtQuick3D
- QtGraphs

## License

MIT + Qt license (GPL / Commercial)
