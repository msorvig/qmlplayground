# QML Playground

A browser-based QML editor and runtime powered by Qt for WebAssembly.

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

#### Methods

| Method | Description |
|--------|-------------|
| `load()` | Load the Qt runtime (async) |
| `loadQml(source)` | Load and run QML source code |
| `getErrors()` | Get errors/warnings from last load |
| `clear()` | Clear the QML scene |

## Building

### Prerequisites

- Qt 6.8+ built for WebAssembly
- Emscripten SDK (matching your Qt build)
- CMake 3.16+

### Build and Deploy

```bash
mkdir build-wasm && cd build-wasm
source /path/to/emsdk/emsdk_env.sh
/path/to/qt-wasm/bin/qt-cmake ..
cmake --build . --target deploy
```

Or from the project root:

```bash
cmake --build build-wasm --target deploy
```

The `deploy` target builds the WebAssembly runtime and copies all files to `deploy/`.

## Project Structure

```
CMakeLists.txt          Build and deploy configuration
cmake/
  patch_esm.cmake       ES module patching script
src/
  index.html            Demo page
  qmlplayground.js      QmlPlayground component (Shadow DOM)
  qmlruntime.js         QmlRuntime wrapper
  main.cpp              C++ entry point
  qmlruntime.cpp/h      C++ QML runtime
  imports.qml           QML imports for static linking
3rdparty/
  codemirror/           CodeMirror editor (MIT license)
examples/
  index.json            Examples index
  *.qml                 Example files
deploy/                 Generated output (gitignored)
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
