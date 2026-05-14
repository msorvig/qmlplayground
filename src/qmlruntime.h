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

signals:
    void errorsChanged(const QString &errors);
    void loaded();
    void errorOccurred(int line, int column, const QString &message);
    void warningOccurred(int line, int column, const QString &message);

private:
    void clearErrors();
    void handleComponentStatus();
    void handleWarnings(const QList<QQmlError> &warnings);

    std::unique_ptr<QQmlEngine> m_engine;
    std::unique_ptr<QQuickWindow> m_window;
    std::unique_ptr<QQmlComponent> m_component;
    QQuickItem *m_rootItem = nullptr;
    QQuickWindow *m_rootWindow = nullptr;
    QStringList m_errors;
    QStringList m_warnings;
};

#endif // QMLRUNTIME_H
