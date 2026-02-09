#include "qmlruntime.h"
#include <QQmlContext>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonDocument>

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
        // Grey out old content on error
        if (m_rootItem) {
            m_rootItem->setOpacity(0.3);
        }
        emit errorsChanged(getErrors());
        return;
    }

    if (!m_component->isReady()) {
        return;
    }

    // Create the root object
    QObject *obj = m_component->create();
    if (!obj) {
        m_errors.append("Failed to create root object");
        if (m_rootItem) {
            m_rootItem->setOpacity(0.3);
        }
        emit errorsChanged(getErrors());
        return;
    }

    QQuickItem *newRootItem = qobject_cast<QQuickItem*>(obj);
    if (!newRootItem) {
        m_errors.append("Root object is not a QQuickItem");
        obj->deleteLater();
        if (m_rootItem) {
            m_rootItem->setOpacity(0.3);
        }
        emit errorsChanged(getErrors());
        return;
    }

    // Success - clean up old root item
    if (m_rootItem) {
        m_rootItem->setParentItem(nullptr);
        m_rootItem->deleteLater();
    }
    m_rootItem = newRootItem;

    // Parent to window's content item
    m_rootItem->setParentItem(m_window->contentItem());
    m_rootItem->setOpacity(1.0);

    // If root item uses anchors.fill: parent, this enables it
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
