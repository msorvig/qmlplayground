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
#include <QStyleHints>
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

std::string refreshRoot(int id)
{
    if (QmlRuntime *r = previewById(id))
        return r->refreshRoot().toStdString();
    return "{}";
}

std::string getQtVersion()
{
    return qVersion();
}

// Force the application color scheme (process-global). "auto" follows the
// system / browser prefers-color-scheme.
void setColorScheme(const std::string& scheme)
{
    QStyleHints *hints = QGuiApplication::styleHints();
    if (scheme == "light")
        hints->setColorScheme(Qt::ColorScheme::Light);
    else if (scheme == "dark")
        hints->setColorScheme(Qt::ColorScheme::Dark);
    else
        hints->unsetColorScheme();
}

void setOnError(emscripten::val callback)   { g_onError = callback; }
void setOnWarning(emscripten::val callback) { g_onWarning = callback; }
void setOnLoaded(emscripten::val callback)  { g_onLoaded = callback; }

// --- Hot reload: the QmlPreview debug service, driven from JS ----------------
//
// qtdeclarative's QmlPreview service (qmldbg_preview) can patch a running
// scene in place when a document changes: only the changed documents are
// recompiled and the live objects keep their state. It is a debug service,
// normally reached over a socket by tools such as qmlpreview. Here it runs
// inside this wasm instance behind the in-process native debug connector
// (qmldbg_native): no socket, no thread — every message is dispatched
// synchronously on this, the only, thread.
//
// JS plays the client. It speaks the same wire protocol as QQmlPreviewClient;
// the QDataStream packet encoding lives here so JS never has to emulate it.

#include <QtQml/QQmlDebuggingEnabler>
#include <QDataStream>
#include <private/qqmldebugconnector_p.h>
#include <private/qqmldebugservice_p.h>

namespace {

// Mirrors QQmlPreviewClient::Command; the values are the wire contract.
enum PreviewCommand : qint8 {
    PreviewFile, PreviewLoad, PreviewRequest, PreviewError, PreviewRerun, PreviewDirectory,
    PreviewClearCache, PreviewZoom, PreviewFps, PreviewAnimationSpeed, PreviewConfiguration,
    PreviewConfirmation, PreviewHotReloadFailure,
};

QQmlDebugService *g_previewService = nullptr;
emscripten::val g_onPreviewMessage = emscripten::val::null();

template <typename Writer>
void previewSend(Writer &&write)
{
    if (!g_previewService)
        return;
    QByteArray data;
    QDataStream stream(&data, QIODevice::WriteOnly);
    stream.setVersion(QQmlDebugConnector::dataStreamVersion());
    write(stream);
    g_previewService->messageReceived(data);
}

// Decode a service → client packet and hand it to JS as (type, payload).
void forwardPreviewMessage(const QString &, const QByteArray &message)
{
    QDataStream stream(message);
    stream.setVersion(QQmlDebugConnector::dataStreamVersion());
    qint8 command = -1;
    stream >> command;

    std::string type, payload;
    auto text = [&stream]() { QString s; stream >> s; return s.toStdString(); };
    switch (command) {
    case PreviewError:            type = "error";            payload = text(); break;
    case PreviewRequest:          type = "request";          payload = text(); break;
    case PreviewHotReloadFailure: type = "hotReloadFailure"; payload = text(); break;
    case PreviewConfirmation: {
        bool inPlace = false;
        stream >> inPlace;
        type = "confirmation";
        payload = inPlace ? "true" : "false";
        break;
    }
    case PreviewFps:              type = "fps"; break;      // not decoded
    default:                      type = "unknown"; payload = std::to_string(command); break;
    }

    if (!g_onPreviewMessage.isNull() && g_onPreviewMessage.typeOf().as<std::string>() == "function")
        g_onPreviewMessage(type, payload);
}

} // namespace

// Start the connector and the service. Must run before the first QML engine
// is created: engines register with the connector in their constructor, and
// the service only patches engines it has seen. Idempotent.
bool startPreviewService()
{
    if (g_previewService)
        return true;

    QQmlDebuggingEnabler::enableDebugging(false);
    QQmlDebuggingEnabler::setServices({ QStringLiteral("QmlPreview") });
    if (!QQmlDebuggingEnabler::startDebugConnector(QStringLiteral("QQmlNativeDebugConnector"))) {
        qWarning("QmlPreview: could not start the native debug connector");
        return false;
    }

    QQmlDebugConnector *connector = QQmlDebugConnector::instance();
    QQmlDebugService *service = connector ? connector->service(QStringLiteral("QmlPreview")) : nullptr;
    if (!service) {
        qWarning("QmlPreview: service not available");
        return false;
    }

    // What a native debugger does through qt_qmlDebugEnableService(): the
    // service installs its file engine handler on the transition to Enabled.
    if (service->state() != QQmlDebugService::Enabled) {
        service->stateAboutToBeChanged(QQmlDebugService::Enabled);
        service->setState(QQmlDebugService::Enabled);
        service->stateChanged(QQmlDebugService::Enabled);
    }

    QObject::connect(service, &QQmlDebugService::messageToClient, forwardPreviewMessage);
    g_previewService = service;
    return true;
}

void setOnPreviewMessage(emscripten::val callback) { g_onPreviewMessage = callback; }

// Ask for in-place updates. The service answers with a Confirmation message.
void previewConfigure(bool inPlace)
{
    previewSend([inPlace](QDataStream &s) { s << qint8(PreviewConfiguration) << inPlace; });
}

// Hand the service a document's new contents. Marks the document as changed;
// the next Load recompiles it and patches its live objects.
void previewSendFile(const std::string &path, const std::string &contents)
{
    previewSend([&](QDataStream &s) {
        s << qint8(PreviewFile) << QString::fromStdString(path) << QByteArray::fromStdString(contents);
    });
}

void previewLoad(const std::string &url)
{
    previewSend([&](QDataStream &s) { s << qint8(PreviewLoad) << QUrl(QString::fromStdString(url)); });
}

// Forget pushed file contents so the type loader reads the filesystem again.
void previewClearCache()
{
    previewSend([](QDataStream &s) { s << qint8(PreviewClearCache); });
}

EMSCRIPTEN_BINDINGS(qmlplayground) {
    emscripten::function("createPreview", &createPreview);
    emscripten::function("destroyPreview", &destroyPreview);
    emscripten::function("loadQml", &loadQml);
    emscripten::function("loadEntryFile", &loadEntryFile);
    emscripten::function("clearContent", &clearContent);
    emscripten::function("setSizeMode", &setSizeMode);
    emscripten::function("getErrors", &getErrors);
    emscripten::function("refreshRoot", &refreshRoot);
    emscripten::function("getQtVersion", &getQtVersion);
    emscripten::function("setColorScheme", &setColorScheme);
    emscripten::function("setOnError", &setOnError);
    emscripten::function("setOnWarning", &setOnWarning);
    emscripten::function("setOnLoaded", &setOnLoaded);
    emscripten::function("startPreviewService", &startPreviewService);
    emscripten::function("setOnPreviewMessage", &setOnPreviewMessage);
    emscripten::function("previewConfigure", &previewConfigure);
    emscripten::function("previewSendFile", &previewSendFile);
    emscripten::function("previewLoad", &previewLoad);
    emscripten::function("previewClearCache", &previewClearCache);
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
