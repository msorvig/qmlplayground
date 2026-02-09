import QtQuick

Rectangle {
    anchors.fill: parent
    color: "#2d2d30"

    Rectangle {
        id: box
        width: 100
        height: 100
        anchors.centerIn: parent
        color: "#0e639c"
        radius: 8

        RotationAnimation on rotation {
            from: 0
            to: 360
            duration: 3000
            loops: Animation.Infinite
        }

        SequentialAnimation on scale {
            loops: Animation.Infinite
            NumberAnimation { to: 1.2; duration: 500; easing.type: Easing.OutQuad }
            NumberAnimation { to: 1.0; duration: 500; easing.type: Easing.InQuad }
        }
    }

    Text {
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 20
        anchors.horizontalCenter: parent.horizontalCenter
        text: "Animated Rectangle"
        color: "#808080"
        font.pixelSize: 14
    }
}
