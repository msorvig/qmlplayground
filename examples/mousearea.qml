import QtQuick

Rectangle {
    anchors.fill: parent
    color: "#1e1e1e"

    Rectangle {
        id: box
        width: 100
        height: 100
        x: parent.width / 2 - width / 2
        y: parent.height / 2 - height / 2
        color: mouseArea.pressed ? "#ff6b6b" : "#4ecdc4"
        radius: 8

        Behavior on color {
            ColorAnimation { duration: 200 }
        }

        MouseArea {
            id: mouseArea
            anchors.fill: parent
            drag.target: parent
        }
    }
}
