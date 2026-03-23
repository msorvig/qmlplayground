#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include "qmlruntime.h"

#ifdef Q_OS_WASM
#include <emscripten/bind.h>
#include <emscripten/val.h>
#endif

static QGuiApplication *g_app = nullptr;
static QmlRuntime* g_runtime = nullptr;

#ifdef Q_OS_WASM
static emscripten::val g_onError = emscripten::val::null();
static emscripten::val g_onWarning = emscripten::val::null();
static emscripten::val g_onLoaded = emscripten::val::null();

void loadQml(const std::string& source)
{
    if (g_runtime) {
        g_runtime->loadQml(QString::fromStdString(source));
    }
}

std::string getErrors()
{
    if (g_runtime) {
        return g_runtime->getErrors().toStdString();
    }
    return "[]";
}

std::string getQtVersion()
{
    return qVersion();
}

void clearContent()
{
    if (g_runtime) {
        g_runtime->loadQml("");
    }
}

void setOnError(emscripten::val callback)
{
    g_onError = callback;
}

void setOnWarning(emscripten::val callback)
{
    g_onWarning = callback;
}

void setOnLoaded(emscripten::val callback)
{
    g_onLoaded = callback;
}

// Called from Qt signals
void notifyError(int line, int column, const std::string& message)
{
    if (!g_onError.isNull() && g_onError.typeOf().as<std::string>() == "function") {
        g_onError(line, column, message);
    }
}

void notifyWarning(int line, int column, const std::string& message)
{
    if (!g_onWarning.isNull() && g_onWarning.typeOf().as<std::string>() == "function") {
        g_onWarning(line, column, message);
    }
}

void notifyLoaded()
{
    if (!g_onLoaded.isNull() && g_onLoaded.typeOf().as<std::string>() == "function") {
        g_onLoaded();
    }
}

EMSCRIPTEN_BINDINGS(qmlplayground) {
    emscripten::function("loadQml", &loadQml);
    emscripten::function("getErrors", &getErrors);
    emscripten::function("getQtVersion", &getQtVersion);
    emscripten::function("clearContent", &clearContent);
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
    char **heapArgv = new char*[argc + 1];
    for (int i = 0; i < argc; ++i)
        heapArgv[i] = strdup(argv[i]);
    heapArgv[argc] = nullptr;

    g_app = new QGuiApplication(argc, heapArgv);

    g_runtime = new QmlRuntime();

#ifdef Q_OS_WASM
    // Connect signals to JavaScript callbacks
    QObject::connect(g_runtime, &QmlRuntime::errorOccurred,
        [](int line, int column, const QString &message) {
            notifyError(line, column, message.toStdString());
        });

    QObject::connect(g_runtime, &QmlRuntime::warningOccurred,
        [](int line, int column, const QString &message) {
            notifyWarning(line, column, message.toStdString());
        });

    QObject::connect(g_runtime, &QmlRuntime::loaded, []() {
        notifyLoaded();
    });
#endif

    // Load default QML
    g_runtime->loadQml(R"(
        import QtQuick

        Rectangle {
            anchors.fill: parent
            color: "#1e1e1e"

            Text {
                anchors.centerIn: parent
                text: "QML Playground"
                color: "#ffffff"
                font.pixelSize: 24
            }
        }
    )");

    return 0; // No exec(); return to browser event loop
}
