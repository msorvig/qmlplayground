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
| `getValue()` | Get editor content |
| `setValue(source)` | Set editor content |
| `run()` | Run current editor content |
| `refresh()` | Refresh editor layout |
| `getExamples()` | Get loaded examples array |
| `loadExample(name)` | Load example by name or filename (async) |

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
| `mode` | `'static'` | `'static'` for monolithic build, `'shared'` for dynamic linking |
| `loggingRules` | `''` | Qt logging filter rules (semicolon-separated), passed via `QT_LOGGING_RULES` |

#### Methods

| Method | Description |
|--------|-------------|
| `load()` | Load the Qt runtime (async) |
| `destroy()` | Tear down the runtime and clean up |
| `loadQml(source)` | Load and run QML source code |
| `getErrors()` | Get errors/warnings from last load |
| `clear()` | Clear the QML scene |

## Build Modes

The playground supports two build modes:

| | Static | Shared |
|---|---|---|
| Linking | All Qt modules in one wasm binary | Core + QML engine only; modules loaded on demand |
| Size | Large (~38 MB) | Small initial download; modules fetched as needed |
| Qt build | `qt/wasm/` (static libs) | `qt/wasm-shared/` (shared libs) |
| Deploy dir | `deploy/static/` | `deploy/shared/` |

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
deploy/
  index.html              Web frontend (served from root)
  qmlplayground.js
  qmlruntime.js
  codemirror.min.js/css
  examples/
  static/                 Static build runtime
    qmlruntime_wasm.js
    qmlruntime_wasm.wasm
    qtloader.js
  shared/                 Shared build runtime
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
CMakeLists.txt          Build config (QMLPLAYGROUND_SHARED option)
build.sh                Top-level build script for both variants
cmake/
  patch_esm.cmake       ES module patching script
src/
  index.html            Demo page
  qmlplayground.js      QmlPlayground component (Shadow DOM)
  qmlruntime.js         QmlRuntime wrapper (handles static/shared paths)
  main.cpp              C++ entry point
  qmlruntime.cpp/h      C++ QML runtime
  imports.qml           QML imports for static linking
  qt.conf               Qt prefix config for shared builds
  qt_plugins.json       Platform plugin preload for shared builds
3rdparty/
  codemirror/           CodeMirror editor (MIT license)
examples/
  index.json            Examples index
  *.qml                 Example files
deploy/                 Generated output (gitignored)
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
