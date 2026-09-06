#ifndef QMLRUNTIME_H
#define QMLRUNTIME_H

#include <QObject>
#include <QQmlEngine>
#include <QQmlComponent>
#include <QQuickWindow>
#include <QQuickItem>
#include <QPointer>
#include <memory>

class QScreen;

class QmlRuntime : public QObject
{
    Q_OBJECT

public:
    // `screen` places this view's window on a specific QScreen (i.e. a
    // specific DOM container). Null uses the default/primary screen.
    explicit QmlRuntime(QScreen *screen = nullptr, QObject *parent = nullptr);
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

    // After an in-place update (hot reload): report the root's state as JSON
    // and mend what a rebuild can undo. The QmlPreview service rebuilds a
    // document root in place, but the root's parent and geometry are set from
    // here rather than by bindings, so re-establish them. The JS side falls
    // back to a full load when the root is gone or has no size.
    QString refreshRoot();

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
    // QPointers: the QmlPreview service may delete a root it cannot patch.
    QPointer<QQuickItem> m_rootItem;
    QPointer<QQuickWindow> m_rootWindow;
    bool m_fillWidth = true;
    bool m_fillHeight = true;
    QStringList m_errors;
    QStringList m_warnings;
};

#endif // QMLRUNTIME_H
