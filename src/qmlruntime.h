#ifndef QMLRUNTIME_H
#define QMLRUNTIME_H

#include <QObject>
#include <QQmlEngine>
#include <QQmlComponent>
#include <QQuickWindow>
#include <QQuickItem>
#include <memory>

class QmlRuntime : public QObject
{
    Q_OBJECT

public:
    explicit QmlRuntime(QObject *parent = nullptr);
    ~QmlRuntime();

    void loadQml(const QString &source);
    // Load an entry file from an absolute path (e.g. "/project/Main.qml").
    // The JS side is expected to have populated that path's parent directory
    // (e.g. via Emscripten FS.writeFile) with all the project's files.
    void loadEntryFile(const QString &absolutePath);
    QString getErrors() const;

    // Controls how the root item is sized within the window. When an axis
    // "fills", the root is stretched to the window on that axis; otherwise the
    // root keeps its implicit size and is centered on that axis. Default is
    // fill on both axes (so anchors.fill-style roots work, e.g. the
    // playground). A component preview typically wants center (no fill), with
    // e.g. a TextArea filling both and a horizontal Slider filling width.
    void setSizePolicy(bool fillWidth, bool fillHeight);

signals:
    void errorsChanged(const QString &errors);
    void loaded();
    void errorOccurred(int line, int column, const QString &message);
    void warningOccurred(int line, int column, const QString &message);

private:
    void clearErrors();
    void handleComponentStatus();
    void handleWarnings(const QList<QQmlError> &warnings);
    // Apply the current size policy to m_rootItem: fill or center per axis.
    void applyRootSizing();

    std::unique_ptr<QQmlEngine> m_engine;
    std::unique_ptr<QQuickWindow> m_window;
    std::unique_ptr<QQmlComponent> m_component;
    QQuickItem *m_rootItem = nullptr;
    QQuickWindow *m_rootWindow = nullptr;
    bool m_fillWidth = true;
    bool m_fillHeight = true;
    QStringList m_errors;
    QStringList m_warnings;
};

#endif // QMLRUNTIME_H
