// Qt Quick Controls catalog — a small SPA over QmlComponentViewer.
//
// Same contract as index.html: each example is a `.example` block with a
// `.code` host holding clean sample QML and an empty `.preview`. One shared
// QmlComponentViewer is reused across navigation, so the wasm compiles once
// for the whole catalog and every preview instantiates from that module.
//
// Each example may set `fill` to control how the runtime sizes the control in
// the preview box: omitted/'none' keeps the implicit size and centers it,
// 'width'/'height' fill that axis, 'both' fills the box (e.g. TextArea).

import { QmlComponentViewer } from './componentviewer.js';

const catalog = [
    {
        group: 'Buttons',
        items: [
            {
                name: 'Button',
                desc: 'A push button. Properties: text, highlighted, flat, checkable/checked, enabled.',
                examples: [
                    { title: 'Basic', qml: `Button {
    text: "Button"
}` },
                    { title: 'Highlighted', qml: `Button {
    text: "OK"
    highlighted: true
}` },
                    { title: 'Flat', qml: `Button {
    text: "Flat"
    flat: true
}` },
                    { title: 'Checkable', qml: `Button {
    text: "Toggle"
    checkable: true
    checked: true
}` },
                ],
            },
            {
                name: 'ToolButton',
                desc: 'A flat button for toolbars. Properties: text, checkable/checked, enabled.',
                examples: [
                    { title: 'Basic', qml: `ToolButton {
    text: "Tool"
}` },
                    { title: 'Checked', qml: `ToolButton {
    text: "Bold"
    checkable: true
    checked: true
}` },
                ],
            },
            {
                name: 'RoundButton',
                desc: 'A button with a fully rounded shape. Properties: text, radius, highlighted, flat.',
                examples: [
                    { title: 'Basic', qml: `RoundButton {
    text: "+"
}` },
                    { title: 'Highlighted', qml: `RoundButton {
    text: "+"
    highlighted: true
}` },
                ],
            },
            {
                name: 'DelayButton',
                desc: 'A check button activated by a press-and-hold. Properties: text, delay, progress.',
                examples: [
                    { title: 'Hold to activate', qml: `DelayButton {
    text: "Hold"
    delay: 1000
}` },
                ],
            },
        ],
    },
    {
        group: 'Selectors',
        items: [
            {
                name: 'CheckBox',
                desc: 'A checkable option. Properties: text, checked, tristate/checkState, enabled.',
                examples: [
                    { title: 'Basic', qml: `CheckBox {
    text: "Accept terms"
}` },
                    { title: 'Checked', qml: `CheckBox {
    text: "Subscribe"
    checked: true
}` },
                    { title: 'Tri-state', qml: `CheckBox {
    text: "Select all"
    tristate: true
    checkState: Qt.PartiallyChecked
}` },
                ],
            },
            {
                name: 'RadioButton',
                desc: 'An exclusive option within its parent. Properties: text, checked.',
                examples: [
                    { title: 'Group', qml: `Column {
    spacing: 8
    RadioButton { text: "Small" }
    RadioButton { text: "Medium"; checked: true }
    RadioButton { text: "Large" }
}` },
                ],
            },
            {
                name: 'Switch',
                desc: 'An on/off toggle. Properties: text, checked, enabled.',
                examples: [
                    { title: 'Off / On', qml: `Switch {
    text: "Wi-Fi"
}` },
                    { title: 'Checked', qml: `Switch {
    text: "Bluetooth"
    checked: true
}` },
                ],
            },
        ],
    },
    {
        group: 'Inputs',
        items: [
            {
                name: 'Slider',
                desc: 'A value slider. Properties: value, from/to, stepSize, snapMode, orientation.',
                examples: [
                    { title: 'Value', fill: 'width', qml: `Slider {
    value: 0.5
}` },
                    { title: 'Stepped + snapping', fill: 'width', qml: `Slider {
    from: 0
    to: 100
    stepSize: 5
    snapMode: Slider.SnapAlways
    value: 40
}` },
                    { title: 'Vertical', fill: 'height', qml: `Slider {
    orientation: Qt.Vertical
    value: 0.7
}` },
                ],
            },
            {
                name: 'RangeSlider',
                desc: 'A slider with two handles. Properties: first.value, second.value, from/to, stepSize.',
                examples: [
                    { title: 'Range', fill: 'width', qml: `RangeSlider {
    first.value: 0.25
    second.value: 0.75
}` },
                ],
            },
            {
                name: 'Dial',
                desc: 'A circular value control. Properties: value, from/to, stepSize.',
                examples: [
                    { title: 'Value', qml: `Dial {
    value: 0.3
}` },
                    { title: 'Stepped', qml: `Dial {
    from: 0
    to: 10
    stepSize: 1
    value: 4
}` },
                ],
            },
            {
                name: 'SpinBox',
                desc: 'A numeric stepper. Properties: value, from/to, stepSize, editable.',
                examples: [
                    { title: 'Basic', qml: `SpinBox {
    value: 5
}` },
                    { title: 'Range + step', qml: `SpinBox {
    from: 0
    to: 100
    stepSize: 10
    value: 30
}` },
                    { title: 'Editable', qml: `SpinBox {
    editable: true
    value: 50
}` },
                ],
            },
            {
                name: 'ComboBox',
                desc: 'A drop-down selector. Properties: model, currentIndex, editable.',
                examples: [
                    { title: 'Basic', fill: 'width', qml: `ComboBox {
    model: ["Apple", "Banana", "Cherry"]
}` },
                    { title: 'Editable', fill: 'width', qml: `ComboBox {
    editable: true
    model: ["One", "Two", "Three"]
}` },
                ],
            },
            {
                name: 'TextField',
                desc: 'A single-line text input. Properties: text, placeholderText, readOnly, echoMode.',
                examples: [
                    { title: 'Placeholder', fill: 'width', qml: `TextField {
    placeholderText: "Enter your name"
}` },
                    { title: 'Read only', fill: 'width', qml: `TextField {
    text: "Read only"
    readOnly: true
}` },
                    { title: 'Password', fill: 'width', qml: `TextField {
    text: "secret"
    echoMode: TextInput.Password
}` },
                ],
            },
            {
                name: 'TextArea',
                desc: 'A multi-line text input. Properties: text, placeholderText, wrapMode, readOnly.',
                examples: [
                    { title: 'Wrapping', fill: 'both', qml: `TextArea {
    placeholderText: "Type several lines..."
    wrapMode: TextEdit.Wrap
}` },
                ],
            },
        ],
    },
    {
        group: 'Indicators',
        items: [
            {
                name: 'ProgressBar',
                desc: 'A progress indicator. Properties: value, from/to, indeterminate.',
                examples: [
                    { title: 'Determinate', fill: 'width', qml: `ProgressBar {
    value: 0.4
}` },
                    { title: 'Indeterminate', fill: 'width', qml: `ProgressBar {
    indeterminate: true
}` },
                ],
            },
            {
                name: 'BusyIndicator',
                desc: 'A spinning activity indicator. Properties: running.',
                examples: [
                    { title: 'Running', qml: `BusyIndicator {
    running: true
}` },
                ],
            },
            {
                name: 'PageIndicator',
                desc: 'Dots showing the current page. Properties: count, currentIndex.',
                examples: [
                    { title: 'Five pages', qml: `PageIndicator {
    count: 5
    currentIndex: 2
}` },
                ],
            },
        ],
    },
    {
        group: 'Containers',
        items: [
            {
                name: 'Label',
                desc: 'Styled text. Properties: text, color, font.*.',
                examples: [
                    { title: 'Plain', qml: `Label {
    text: "Plain label"
}` },
                    { title: 'Styled', qml: `Label {
    text: "Styled label"
    color: "steelblue"
    font.pixelSize: 22
    font.bold: true
}` },
                ],
            },
            {
                name: 'Frame',
                desc: 'A bordered container around content. Properties: padding, content.',
                examples: [
                    { title: 'Framed', qml: `Frame {
    Label { text: "Framed content" }
}` },
                ],
            },
            {
                name: 'GroupBox',
                desc: 'A titled container that groups related controls. Properties: title.',
                examples: [
                    { title: 'Settings', qml: `GroupBox {
    title: "Settings"
    Column {
        spacing: 6
        CheckBox { text: "Enable" }
        CheckBox { text: "Verbose"; checked: true }
    }
}` },
                ],
            },
            {
                name: 'Pane',
                desc: 'A surface with the theme background color. Properties: padding, content.',
                examples: [
                    { title: 'Pane', qml: `Pane {
    Label { text: "On a themed pane" }
}` },
                ],
            },
            {
                name: 'Tumbler',
                desc: 'A spinnable wheel of items. Properties: model, currentIndex, visibleItemCount.',
                examples: [
                    { title: 'Wheel', qml: `Tumbler {
    model: 12
}` },
                ],
            },
        ],
    },
];

const allItems = catalog.flatMap(g => g.items);

const viewer = new QmlComponentViewer({
    preamble: 'import QtQuick\nimport QtQuick.Controls',
    // One wasm instance hosting all previews (one window+engine each). The
    // catalog uses a single global style, so per-preview style isolation
    // isn't needed — shared instancing is lighter.
    instancing: 'shared',
});

const nav = document.getElementById('nav');
const content = document.getElementById('content');
const select = document.getElementById('style-select');
const schemeSelect = document.getElementById('scheme-select');

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
}

function buildNav() {
    nav.append(el('div', 'brand', 'Qt Quick Controls'));
    for (const { group, items } of catalog) {
        nav.append(el('h3', null, group));
        for (const comp of items) {
            const a = el('a', null, comp.name);
            a.href = '#' + encodeURIComponent(comp.name);
            a.dataset.name = comp.name;
            nav.append(a);
        }
    }
}

function markActive(name) {
    for (const a of nav.querySelectorAll('a'))
        a.classList.toggle('active', a.dataset.name === name);
}

async function show(name) {
    const comp = allItems.find(c => c.name === name) || allItems[0];

    // Tear down the previous page's previews (frees their runtimes), then
    // render this component's examples as the index.html-style markup.
    for (const p of viewer.previews()) p.destroy();
    content.innerHTML = '';

    content.append(el('h1', 'comp-title', comp.name));
    content.append(el('p', 'comp-desc', comp.desc));

    for (const ex of comp.examples) {
        content.append(el('div', 'ex-title', ex.title));
        const example = el('div', 'example');
        const code = el('pre', 'code', ex.qml);   // sample QML = the .code text
        const preview = el('div', 'preview');
        if (ex.fill) preview.dataset.fill = ex.fill;   // scanAndAttach reads this
        example.append(code, preview);
        content.append(example);
    }

    await viewer.scanAndAttach(content);
    markActive(comp.name);
    document.title = `${comp.name} — Qt Quick Controls`;

    // New previews focus their canvas (which scrolls it into view); land the
    // page back at the top for the freshly-selected component.
    window.scrollTo(0, 0);
    requestAnimationFrame(() => window.scrollTo(0, 0));
}

function route() {
    const name = decodeURIComponent(location.hash.slice(1));
    show(name);
}

buildNav();
window.addEventListener('hashchange', route);
route();

select.addEventListener('change', async () => {
    select.disabled = true;
    await viewer.setStyle(select.value);
    select.disabled = false;
});

// Light/dark toggle — applied live (no reload).
schemeSelect.addEventListener('change', () => {
    viewer.setColorScheme(schemeSelect.value);
});
