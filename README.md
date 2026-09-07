# QML Playground

A browser-based QML editor and runtime powered by Qt for WebAssembly.

**Try it:** [msorvig.github.io/qmlplayground](https://msorvig.github.io/qmlplayground/)

## Two front-ends, one core

The repository ships two web front-ends over a shared core:

| | Entry page | What it is |
|---|---|---|
| **Playground** | `index.html` | Full-window IDE: editor pane, live preview, console, examples, settings |
| **Component viewer** | `catalog.html`, `components.html` | Inline live previews embedded next to code samples in a doc-style page |

Both are built on the same three shared modules — `qmlruntime.js`
(`QmlInstance` / `QmlViewer` / `QmlRuntime`), `qmleditor.js` (`QmlEditor`) and
`qmlproject.js` (`QmlProject`). There is one wasm binary and one build for
both.

In the source tree the shared modules live in `src/` and each front-end has
its own directory under `src/frontend/`. The build deploys everything flat
into `dist/`, so the pages and the modules they import end up as siblings.

## Features

- Live QML editing with syntax highlighting
- Auto-run on code changes
- Error and warning display with line markers
- Built-in examples for QtQuick, QtQuick Controls, Qt Quick 3D, and Qt Graphs
- Hot reload: edits patch the running scene in place, so it keeps its state
- Embeddable live previews for documentation pages

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

### QmlComponentViewer

The other front-end: instead of one full-window editor, it puts many small
live previews inline in a host page, each next to the sample that produced it.
`catalog.html` (a Qt Quick Controls catalog) and `components.html` (a Slider
page) are the two demos.

A sample is authored in two parts: the *preamble* (imports the runtime needs,
which the reader doesn't care about) and the *sample* (the snippet on show).
The preview runs `preamble + sample`; the editor displays only the sample, and
error lines are mapped back by subtracting the preamble's line count.

```javascript
import { QmlComponentViewer } from './componentviewer.js';

const viewer = new QmlComponentViewer({
    preamble: 'import QtQuick\nimport QtQuick.Controls',
    instancing: 'shared',
});
await viewer.scanAndAttach();       // scans the page for .example blocks
await viewer.setStyle('Material');  // relaunches every preview
viewer.setColorScheme('dark');
```

`scanAndAttach()` looks for `.example` blocks, each holding a `.code` element
whose text *is* the sample and an empty `.preview` element for the runtime:

```html
<div class="example">
    <pre class="code">Button { text: "Hi" }</pre>
    <div class="preview" data-fill="width"></div>
</div>
```

#### Options

| Option | Default | Description |
|--------|---------|-------------|
| `mode` | `'static'` | Build mode, as for `QmlRuntime` |
| `preamble` | `''` | QML prepended to every sample on the page |
| `style` | `''` | Quick Controls style for every preview (`''` = the build default) |
| `instancing` | `'isolated'` | `'isolated'`: one wasm instance per preview, so each can have its own Controls style. `'shared'`: one instance hosts all previews — lighter, but one style for the page |
| `colorScheme` | `'light'` | `'light'`, `'dark'` or `'auto'` for the previews. The editors stay light |
| `hotReload` | `true` | Patch a preview in place when its sample is edited, so it keeps its state. See [Hot reload](#hot-reload) under `QmlRuntime` |
| `accessibility` | `true` | Expose the previews to screen readers, as for `QmlRuntime` |

The wasm is fetched and compiled once per viewer and every preview
instantiates from that one compiled module, so a page with twenty previews
still compiles the binary a single time.

Each preview is a one-file project in the runtime's in-memory filesystem
(`preview.project`, a `QmlProject`), which is what makes it addressable for
hot reload; a style change still relaunches the previews.

#### Methods

| Method | Description |
|--------|-------------|
| `addPreview(container, options)` | Create one preview. `options`: `qml` or `preamble`/`sample`, `codeHost`, `fill` (`'none'`/`'width'`/`'height'`/`'both'`), `id` |
| `scanAndAttach(root?, options?)` | Instantiate every `.example` block under `root`. Returns the `Preview` handles in DOM order |
| `previews()` / `removePreview(id)` | Inspect / tear down |
| `setStyle(style)` | Change the Quick Controls style. Relaunches every preview (the style is baked into the wasm environment at load), reusing the compiled module and preserving edits |
| `setColorScheme(scheme)` | Change the previews' color scheme live |

Note that `setColorScheme` reliably affects previews created *after* the call:
Qt reads the forced scheme when items are built, so already-running previews
may keep their original styling until they are recreated.

### QmlRuntime

Lower-level wrapper for the Qt WebAssembly runtime: one QML view in a DOM
element, with the Qt process behind it managed for you. Use this when you need
just the runtime without the editor.

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

#### Options

The constructor takes an optional config object. Every option is also a
read/write property of the same name.

```javascript
const runtime = new QmlRuntime(document.getElementById('container'), {
    mode: 'shared',
    controlsStyle: 'Material',
    loggingRules: 'qt.qml.import.debug=true',
    hotReload: true,
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `mode` | `'static'` | `'static'` or `'shared'`; see [Build Modes](#build-modes) |
| `module` | `null` | Pre-compiled `WebAssembly.Module` (or a promise of one) to instantiate from, instead of fetching and compiling |
| `environment` | `{}` | Extra environment variables for the Qt process |
| `loggingRules` | `''` | Qt logging filter rules, one per line, passed via `QT_LOGGING_RULES` |
| `controlsStyle` | `''` | Qt Quick Controls style, e.g. `'Material'`; empty for the build's default |
| `colorScheme` | `''` | `'light'`, `'dark'`, or `'auto'`/empty to follow the system |
| `hotReload` | `false` | Start the QmlPreview service and use it for `loadProject()`; see [Hot reload](#hot-reload) |
| `accessibility` | `false` | Expose the scene to screen readers: sets `QT_WASM_ENABLE_ACCESSIBILITY=1`, and Qt mirrors the scene as accessible HTML elements |
| `fillWidth`, `fillHeight` | `true` | Stretch the root item to the window on that axis; `false` keeps its implicit size and centers it |
| `resizeEnabled` | `true` | Forward container size changes to Qt |

`colorScheme`, `fillWidth`, `fillHeight`, `resizeEnabled` and `hotReload`
apply immediately when set. The others configure the Qt process, and setting
one reloads it: the runtime recreates its instance, emits `loading` and
`ready` again, and re-runs the last loaded QML. Several changes made in one go
cause one reload, and `load()` returns the promise of the reload in flight.

```javascript
runtime.controlsStyle = 'Fusion';
runtime.mode = 'shared';
await runtime.load();       // one reload; the previous QML is running again
```

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

#### Hot reload

By default every `loadProject()` recreates the scene. With `hotReload: true`
the instance runs qtdeclarative's QmlPreview debug service in-process, and a
project that differs from the previous one only in the *contents* of some
files is patched in place instead: the changed documents are recompiled and
the live objects keep their state (slider values, scroll positions, running
animations). The first load, a different entry file, added or removed files,
or a patch the service cannot apply all fall back to a full load. A document
with a compile error keeps the previous scene and recovers on the next
successful edit, still in place.

```javascript
const runtime = new QmlRuntime(container, { hotReload: true });
await runtime.load();
runtime.hotReloadAvailable;   // true once the service confirmed in-place updates
runtime.hotReload = false;    // keep the service, recreate the scene on the next load
runtime.on('qmlloaded', ({ hot, changed, elapsed }) => { /* hot: patched in place */ });
```

| Property | Description |
|----------|-------------|
| `hotReload` | Use in-place updates when available. Read/write, applies to the next `loadProject()`. Turning it on for a runtime whose instance was started without the service reloads the runtime |
| `hotReloadAvailable` | Read-only: the instance runs the service and it confirmed in-place mode. A `QmlInstance` cannot start the service after the fact, since engines register with it when they are created; `QmlRuntime` reloads instead |

The service is reached through the in-process native debug connector, so no
socket and no thread are involved: JS pushes the changed files and a `Load`,
and the recompile and patch have happened when the call returns. Afterwards
the runtime checks the root item: one the service deleted, left without a
size, or stripped of all its children is not usable and triggers a full load.
The last case is a current limitation of the service's rebuild: a root whose
base type supplies its children — a Quick Controls control, whose delegates
come from its style's QML — loses them when a structural edit (adding or
removing a binding or object) rebuilds it, so such edits reload; binding value
changes on the same control patch in place and keep its state. Requires a Qt
build that ships the `qmldbg_native` and `qmldbg_preview` qmltooling plugins
(see [Prerequisites](#prerequisites)); without them `hotReloadAvailable` stays
false and loads are full loads.

#### Methods

| Method | Description |
|--------|-------------|
| `load()` | Load the runtime, or return the promise of the load or reload in flight (async) |
| `destroy()` | Tear down the view and its Qt process |
| `loadQml(source)` | Load a single-string QML source via `QQmlComponent::setData` |
| `loadProject(project)` | Write a `QmlProject` into Emscripten's MEMFS (a directory per view) and load the entry file. Cross-file imports, `qmldir`, and relative URLs resolve through the in-memory filesystem. Patches in place when hot reload applies |
| `getErrors()` | Get errors/warnings from last load |
| `clear()` | Clear the QML scene |

#### Events

| Event | Detail | Description |
|-------|--------|-------------|
| `loading` | - | Runtime starting to load |
| `ready` | `{ loadTime, qtVersion }` | Runtime ready, `loadQml` can be called |
| `qmlloaded` | `{ hot, changed?, elapsed? }` | QML loading complete (success or error); check `getErrors()`. `hot` is true for an in-place update, with the changed paths and the time it took |
| `error` | `{ line, column, message }` | Individual QML error |
| `warning` | `{ line, column, message }` | Individual QML warning |

### QmlInstance and QmlViewer

`QmlRuntime` is a `QmlInstance` (the Qt process) plus a `QmlViewer` (one QML
view on it). Use the two directly to run several views on one process, for
example many small previews on a page: the instance loads once, and the views
share its filesystem, Controls style and color scheme.

```javascript
import { QmlInstance, QmlViewer } from './qmlruntime.js';

const instance = new QmlInstance({ controlsStyle: 'Material', hotReload: true });
const a = new QmlViewer(instance, { container: elementA });
const b = new QmlViewer(instance, { container: elementB, fillWidth: false, fillHeight: false });
await Promise.all([a.load(), b.load()]);
a.loadQml('import QtQuick.Controls\nButton { text: "A" }');
```

`QmlInstance` takes the process-level options from the table above (`mode`,
`module`, `environment`, `loggingRules`, `controlsStyle`, `colorScheme`,
`hotReload`, `accessibility`). All but `colorScheme` are fixed once it is
loaded. It has `load()`, `destroy()`, the read-only `ready`, `qtVersion` and
`hotReloadAvailable`, and the events `loading`, `ready` and `error`.

`QmlViewer` takes an instance and the view-level options (`container`,
`fillWidth`, `fillHeight`, `resizeEnabled`, `hotReload`), all changeable
except `container`. It has the same methods and events as `QmlRuntime`; its
`destroy()` leaves the instance running.

### QmlEditor

CodeMirror-backed QML editor shared by both front-ends. Owns the CodeMirror
instance, the QML language mode, theme selection, and error / warning markers.
Useful on its own if you want a QML editor without the full playground chrome.

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

#### Modes

The two front-ends want different chrome, so the editor has two modes. Pass
`mode` to pick one; individual options override the mode's defaults.

```javascript
// The playground's editor pane (the default).
new QmlEditor(textarea, { mode: 'full' });

// An inline sample in a doc page.
new QmlEditor(div, { mode: 'snippet', source: 'Button { text: "Hi" }' });
```

| | `full` | `snippet` |
|---|---|---|
| Host element | a `<textarea>`, replaced in place | any element, rendered into |
| Line numbers | yes | no |
| Gutter | `error-gutter`, carries error dots | none |
| Height | fills its container | grows to fit the content |
| Bracket close / match | yes | no |
| Ctrl/Cmd+Enter → `run` | yes | no |
| Error display | gutter dot; the host page's CSS shows `data-tooltip` on hover | line tint; a `<body>`-level overlay shows the message on hover |
| Initial `source` | used as-is | dedented first |

`snippet` mode reports errors with its own overlay because a doc page has no
gutter to hang a marker off and supplies no tooltip styling of its own.

#### Methods

| Method | Description |
|--------|-------------|
| `init()` | Async: load CodeMirror, register the QML mode, instantiate. Returns the editor |
| `getValue()` / `setValue(s, { silent? })` | Read / write content. `{ silent: true }` skips the `change` event |
| `focus()` / `hasFocus()` | Focus management |
| `refresh()` | Force a CodeMirror layout recalc |
| `setTheme('dark' \| 'light')` | Swap the CodeMirror theme to match the host UI |
| `addMarker(line, column, message, type)` | Place an error / warning marker on a line. Lines past the end of the document are ignored |
| `clearMarkers()` | Remove all markers |
| `destroy()` | Drop the CodeMirror instance and empty the host element |

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
The selection persists in localStorage. The same dialog has the Hot Reload
toggle (on by default): off, every run recreates the scene. It also has the
Accessibility toggle (on by default), which exposes the scene to screen
readers and reloads the runtime when changed.

## Building

### Prerequisites

- Qt 6.11+ built for WebAssembly (static or shared)
- Emscripten SDK (matching your Qt build)
- CMake 3.16+
- For hot reload: the `qmldbg_native` and `qmldbg_preview` qmltooling plugins.
  Upstream qtdeclarative only builds qmltooling with thread support, which
  Qt for WebAssembly is normally configured without; the bundled qtdeclarative
  (`qt/src/qtdeclarative`) carries the `qmltooling-nothread` patch set that
  builds these two without it. The build works without the plugins, with hot
  reload unavailable.

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
./build.sh docs                # generate the JS API docs only
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

### API documentation

The JS API reference is generated with [TypeDoc](https://typedoc.org) from
the JSDoc comments in `src/qmlruntime.js` and
`src/frontend/playground/qmlplayground.js`. `build.sh deploy` generates it
into `dist/api/`; to generate it alone:

```bash
./build.sh docs
```

This installs TypeDoc into `node_modules/` on first use. `npm run docs` does
the same without the wrapper.

### Deploy layout

Both front-ends' pages sit at the dist root, beside `static/` and `shared/`,
so asset paths resolve the same way for either one.

```
dist/
  index.html              Playground front-end
  catalog.html            Component viewer: Qt Quick Controls catalog
  catalog.js
  components.html         Component viewer: Slider page
  componentviewer.js
  qmlplayground.js
  qmleditor.js
  qmlproject.js
  qmlruntime.js
  codemirror.min.js/css
  titillium-web/          Bundled fonts (woff2)
  examples/
  api/                    Generated JS API docs (TypeDoc)
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
  main.cpp              C++ entry point
  qmlruntime.cpp/h      QmlRuntime C++ source
  imports.qml           QML imports for static linking

  qmlruntime.js         Shared core: QmlInstance / QmlViewer / QmlRuntime
  qmleditor.js          Shared core: QmlEditor (CodeMirror wrapper)
  qmlproject.js         Shared core: QmlProject (multi-file model)

  frontend/
    playground/         The playground
      index.html
      qmlplayground.js
      qmlai.js
      qmlaiui.js
    components/         The component viewer
      catalog.html      Qt Quick Controls catalog
      catalog.js
      components.html   Slider page
      componentviewer.js

  qt.conf               Qt prefix config for shared builds
  qt_plugins.json       Platform plugin preload for shared builds
  qt_plugins_hotreload.json  qmltooling plugin preload for shared builds (hot reload)
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
