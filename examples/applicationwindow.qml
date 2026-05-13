import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Basic

ApplicationWindow {
    id: window
    visible: true
    title: "Hello, ApplicationWindow"

    header: ToolBar {
        Label {
            anchors.centerIn: parent
            text: window.title
            font.pixelSize: 16
        }
    }

    Column {
        anchors.centerIn: parent
        spacing: 12

        Button {
            text: "Click me"
            anchors.horizontalCenter: parent.horizontalCenter
            onClicked: text = "Clicked!"
        }
    }
}
