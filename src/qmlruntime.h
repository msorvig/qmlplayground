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
    QStringList m_errors;
    QStringList m_warnings;
};

#endif // QMLRUNTIME_H
