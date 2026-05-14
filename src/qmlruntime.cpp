#include "qmlruntime.h"
#include <QQmlContext>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonDocument>
#include <QFileInfo>

QmlRuntime::QmlRuntime(QObject *parent)
    : QObject(parent)
    , m_engine(std::make_unique<QQmlEngine>())
    , m_window(std::make_unique<QQuickWindow>())
{
    m_window->setTitle("QML Playground");
    m_window->resize(400, 400);
    m_window->show();

    // Set up engine
    m_engine->setBaseUrl(QUrl("qrc:/"));

    // Add QML import path for shared/dynamic builds — the engine resolves
    // plugin paths relative to this, which maps to HTTP-fetchable URLs.
    // QML_IMPORT_PATH is set by the JS runtime to match the deploy layout.
    const QByteArray qmlImportPath = qgetenv("QML_IMPORT_PATH");
    if (!qmlImportPath.isEmpty())
        m_engine->addImportPath(QString::fromUtf8(qmlImportPath));

    // Capture runtime warnings
    connect(m_engine.get(), &QQmlEngine::warnings, this, &QmlRuntime::handleWarnings);
}

QmlRuntime::~QmlRuntime() = default;

void QmlRuntime::loadQml(const QString &source)
{
    clearErrors();

    // Create new component from source (keep old root item until success)
    m_component = std::make_unique<QQmlComponent>(m_engine.get());
    m_component->setData(source.toUtf8(), QUrl("qml:///main.qml"));

    if (m_component->isLoading()) {
        connect(m_component.get(), &QQmlComponent::statusChanged,
                this, &QmlRuntime::handleComponentStatus);
    } else {
        handleComponentStatus();
    }
}

void QmlRuntime::loadEntryFile(const QString &absolutePath)
{
    clearErrors();

    const QFileInfo fi(absolutePath);
    const QString projectRoot = fi.absolutePath();

    // Evict any cached compilations of the previous project so files with
    // the same name pick up new contents.
    m_engine->clearComponentCache();

    // Files resolve relative to the project root, and module-style imports
    // (qmldir-based) work when the parent of the module directory is on
    // the import path.
    m_engine->setBaseUrl(QUrl::fromLocalFile(projectRoot + QLatin1Char('/')));
    if (!m_engine->importPathList().contains(projectRoot))
        m_engine->addImportPath(projectRoot);

    m_component = std::make_unique<QQmlComponent>(m_engine.get());
    m_component->loadUrl(QUrl::fromLocalFile(absolutePath));

    if (m_component->isLoading()) {
        connect(m_component.get(), &QQmlComponent::statusChanged,
                this, &QmlRuntime::handleComponentStatus);
    } else {
        handleComponentStatus();
    }
}

void QmlRuntime::handleComponentStatus()
{
    if (m_component->isError()) {
        for (const QQmlError &error : m_component->errors()) {
            m_errors.append(QString("%1:%2: %3")
                .arg(error.line())
                .arg(error.column())
                .arg(error.description()));
            emit errorOccurred(error.line(), error.column(), error.description());
        }
        emit errorsChanged(getErrors());
        emit loaded();
        return;
    }

    if (!m_component->isReady()) {
        return;
    }

    // Create the root object. The root may be either a QQuickItem (parented
    // into the placeholder canvas window) or a QQuickWindow / ApplicationWindow
    // (shown as a top-level window — the QtWasm platform maps it to the
    // canvas).
    QObject *obj = m_component->create();
    if (!obj) {
        m_errors.append("Failed to create root object");
        emit errorsChanged(getErrors());
        return;
    }

    QQuickItem *newRootItem = qobject_cast<QQuickItem*>(obj);
    QQuickWindow *newRootWindow = qobject_cast<QQuickWindow*>(obj);

    if (!newRootItem && !newRootWindow) {
        m_errors.append("Root object is not a QQuickItem or QQuickWindow");
        obj->deleteLater();
        emit errorsChanged(getErrors());
        return;
    }

    // Tear down previous root (item or window).
    if (m_rootItem) {
        m_rootItem->setParentItem(nullptr);
        m_rootItem->deleteLater();
        m_rootItem = nullptr;
    }
    if (m_rootWindow) {
        m_rootWindow->setVisible(false);
        m_rootWindow->deleteLater();
        m_rootWindow = nullptr;
    }

    if (newRootWindow) {
        // Window-rooted QML (Window / ApplicationWindow): show it as a
        // top-level window. Hide the placeholder canvas so we don't render
        // an empty surface behind it.
        m_rootWindow = newRootWindow;
        m_window->setVisible(false);
        if (m_rootWindow->width() <= 0 || m_rootWindow->height() <= 0)
            m_rootWindow->resize(m_window->size());
        m_rootWindow->setVisible(true);
    } else {
        m_rootItem = newRootItem;

        // Re-show the placeholder canvas in case a prior load was a window.
        if (!m_window->isVisible())
            m_window->setVisible(true);

        m_rootItem->setParentItem(m_window->contentItem());
        m_rootItem->setOpacity(1.0);

        // Honor anchors.fill: parent
        m_rootItem->setSize(m_window->contentItem()->size());

        // Track window resize
        connect(m_window->contentItem(), &QQuickItem::widthChanged, this, [this]() {
            if (m_rootItem) {
                m_rootItem->setWidth(m_window->contentItem()->width());
            }
        });
        connect(m_window->contentItem(), &QQuickItem::heightChanged, this, [this]() {
            if (m_rootItem) {
                m_rootItem->setHeight(m_window->contentItem()->height());
            }
        });
    }

    emit loaded();
}

void QmlRuntime::clearErrors()
{
    m_errors.clear();
    m_warnings.clear();
}

void QmlRuntime::handleWarnings(const QList<QQmlError> &warnings)
{
    for (const QQmlError &warning : warnings) {
        int line = warning.line();
        int column = warning.column();
        QString description = warning.description();

        // If line is 0 or -1, try to parse "N:" at start of description
        if (line <= 0 && !description.isEmpty() && description[0].isDigit()) {
            int colonPos = description.indexOf(':');
            if (colonPos > 0) {
                bool ok;
                int parsedLine = description.left(colonPos).toInt(&ok);
                if (ok && parsedLine > 0) {
                    line = parsedLine;
                    // Find the actual message after "N:-1: " or "N: "
                    int msgStart = colonPos + 1;
                    while (msgStart < description.length() &&
                           (description[msgStart] == '-' || description[msgStart].isDigit() ||
                            description[msgStart] == ':' || description[msgStart] == ' ')) {
                        msgStart++;
                    }
                    description = description.mid(msgStart);
                }
            }
        }

        m_warnings.append(QString("%1:%2: %3")
            .arg(line)
            .arg(column)
            .arg(description));
        emit warningOccurred(line, column, description);
    }
}

// Parse "line:column: message" format without regex
static void parseIssueString(const QString &str, int &line, int &column, QString &message)
{
    line = 0;
    column = 0;
    message = str;

    // Find first colon (after line number)
    int firstColon = str.indexOf(':');
    if (firstColon <= 0)
        return;

    // Parse line number
    bool ok;
    int parsedLine = str.left(firstColon).toInt(&ok);
    if (!ok)
        return;

    // Find second colon (after column number, which may be negative)
    int secondColon = str.indexOf(':', firstColon + 1);
    if (secondColon <= firstColon)
        return;

    // Parse column number (handles negative values)
    int parsedColumn = str.mid(firstColon + 1, secondColon - firstColon - 1).toInt(&ok);
    if (!ok)
        return;

    // Skip space after second colon if present
    int msgStart = secondColon + 1;
    if (msgStart < str.length() && str[msgStart] == ' ')
        msgStart++;

    line = parsedLine;
    column = parsedColumn;
    message = str.mid(msgStart);
}

QString QmlRuntime::getErrors() const
{
    QJsonArray arr;

    // Add errors
    for (const QString &err : m_errors) {
        QJsonObject obj;
        int line, column;
        QString message;
        parseIssueString(err, line, column, message);
        obj["line"] = line;
        obj["column"] = column;
        obj["message"] = message;
        obj["type"] = "error";
        arr.append(obj);
    }

    // Add warnings
    for (const QString &warn : m_warnings) {
        QJsonObject obj;
        int line, column;
        QString message;
        parseIssueString(warn, line, column, message);
        obj["line"] = line;
        obj["column"] = column;
        obj["message"] = message;
        obj["type"] = "warning";
        arr.append(obj);
    }

    return QString::fromUtf8(QJsonDocument(arr).toJson(QJsonDocument::Compact));
}
