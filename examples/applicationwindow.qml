import QtQuick
import QtQuick.Controls

ApplicationWindow {
    visible: true
    title: "Hello, ApplicationWindow"

    header: ToolBar {
        Label {
            anchors.centerIn: parent
            text: parent.parent.title
            font.pixelSize: 16
        }
    }

    Column {
        anchors.centerIn: parent
        spacing: 12

        Label {
            text: "Root: " + (parent.parent ? parent.parent.toString() : "?")
            anchors.horizontalCenter: parent.horizontalCenter
        }

        Button {
            text: "Click me"
            anchors.horizontalCenter: parent.horizontalCenter
            onClicked: text = "Clicked!"
        }
    }
}
