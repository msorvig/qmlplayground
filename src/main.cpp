#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QFont>
#include <QFontDatabase>
#include "qmlruntime.h"

static void registerBundledFonts()
{
    const char *paths[] = {
        ":/fonts/TitilliumWeb-Regular.ttf",
        ":/fonts/TitilliumWeb-SemiBold.ttf",
        ":/fonts/TitilliumWeb-Bold.ttf",
    };
    for (const char *p : paths) {
        if (QFontDatabase::addApplicationFont(QString::fromLatin1(p)) < 0)
            qWarning("Failed to load bundled font: %s", p);
    }
    QFont f = QGuiApplication::font();
    f.setFamily(QStringLiteral("Titillium Web"));
    QGuiApplication::setFont(f);
}

#ifdef Q_OS_WASM
#include <emscripten/bind.h>
#include <emscripten/val.h>
#endif

static QGuiApplication *g_app = nullptr;

#ifdef Q_OS_WASM
#include <QScreen>
#include <map>

static emscripten::val g_onError = emscripten::val::null();
static emscripten::val g_onWarning = emscripten::val::null();
static emscripten::val g_onLoaded = emscripten::val::null();

// Views (previews) keyed by an integer id handed back to JS. Each is a
// QmlRuntime — one QML engine + one window on one screen (DOM container).
// JS owns the lifecycle via createPreview / destroyPreview.
static std::map<int, QmlRuntime*> g_previews;
static int g_nextPreviewId = 1;

static QmlRuntime *previewById(int id)
{
    auto it = g_previews.find(id);
    return it == g_previews.end() ? nullptr : it->second;
}

// Called from Qt signals; the preview id lets JS route to the right view.
void notifyError(int id, int line, int column, const std::string& message)
{
    if (!g_onError.isNull() && g_onError.typeOf().as<std::string>() == "function")
        g_onError(id, line, column, message);
}

void notifyWarning(int id, int line, int column, const std::string& message)
{
    if (!g_onWarning.isNull() && g_onWarning.typeOf().as<std::string>() == "function")
        g_onWarning(id, line, column, message);
}

void notifyLoaded(int id)
{
    if (!g_onLoaded.isNull() && g_onLoaded.typeOf().as<std::string>() == "function")
        g_onLoaded(id);
}

// Create a view and return its id. The JS side adds the container element
// first (qtAddContainerElement), so the matching screen is the most recently
// added one.
int createPreview()
{
    const QList<QScreen*> screens = QGuiApplication::screens();
    QScreen *screen = screens.isEmpty() ? nullptr : screens.last();

    const int id = g_nextPreviewId++;
    QmlRuntime *runtime = new QmlRuntime(screen);
    g_previews[id] = runtime;

    QObject::connect(runtime, &QmlRuntime::errorOccurred,
        [id](int line, int column, const QString &message) {
            notifyError(id, line, column, message.toStdString());
        });
    QObject::connect(runtime, &QmlRuntime::warningOccurred,
        [id](int line, int column, const QString &message) {
            notifyWarning(id, line, column, message.toStdString());
        });
    QObject::connect(runtime, &QmlRuntime::loaded, [id]() {
        notifyLoaded(id);
    });

    return id;
}

void destroyPreview(int id)
{
    auto it = g_previews.find(id);
    if (it != g_previews.end()) {
        delete it->second;
        g_previews.erase(it);
    }
}

void loadQml(int id, const std::string& source)
{
    if (QmlRuntime *r = previewById(id))
        r->loadQml(QString::fromStdString(source));
}

void loadEntryFile(int id, const std::string& path)
{
    if (QmlRuntime *r = previewById(id))
        r->loadEntryFile(QString::fromStdString(path));
}

void clearContent(int id)
{
    if (QmlRuntime *r = previewById(id))
        r->loadQml("");
}

void setSizeMode(int id, bool fillWidth, bool fillHeight)
{
    if (QmlRuntime *r = previewById(id))
        r->setSizePolicy(fillWidth, fillHeight);
}

std::string getErrors(int id)
{
    if (QmlRuntime *r = previewById(id))
        return r->getErrors().toStdString();
    return "[]";
}

std::string getQtVersion()
{
    return qVersion();
}

void setOnError(emscripten::val callback)   { g_onError = callback; }
void setOnWarning(emscripten::val callback) { g_onWarning = callback; }
void setOnLoaded(emscripten::val callback)  { g_onLoaded = callback; }

EMSCRIPTEN_BINDINGS(qmlplayground) {
    emscripten::function("createPreview", &createPreview);
    emscripten::function("destroyPreview", &destroyPreview);
    emscripten::function("loadQml", &loadQml);
    emscripten::function("loadEntryFile", &loadEntryFile);
    emscripten::function("clearContent", &clearContent);
    emscripten::function("setSizeMode", &setSizeMode);
    emscripten::function("getErrors", &getErrors);
    emscripten::function("getQtVersion", &getQtVersion);
    emscripten::function("setOnError", &setOnError);
    emscripten::function("setOnWarning", &setOnWarning);
    emscripten::function("setOnLoaded", &setOnLoaded);
}
#endif


int main(int argc, char *argv[])
{
    // Copy argv to the heap — on wasm, main's stack frame is
    // invalidated when main() returns to the event loop, but
    // QCoreApplication keeps a reference to argv.
    static int heapArgc = argc;
    static char **heapArgv = new char*[argc + 1];
    for (int i = 0; i < argc; ++i)
        heapArgv[i] = strdup(argv[i]);
    heapArgv[argc] = nullptr;

    g_app = new QGuiApplication(heapArgc, heapArgv);

    registerBundledFonts();

    // Views are created on demand from JS via createPreview(); there is no
    // implicit runtime here. Hand control back to the browser event loop.
    return 0; // No exec()
}
