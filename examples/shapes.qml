import QtQuick
import QtQuick.Shapes

Rectangle {
    anchors.fill: parent
    color: "#1e1e1e"

    Shape {
        anchors.centerIn: parent
        width: 360; height: 240
        layer.enabled: true
        layer.samples: 4

        ShapePath {
            strokeWidth: 3
            strokeColor: "#4fc3f7"
            fillGradient: LinearGradient {
                x1: 0; y1: 0; x2: 0; y2: 240
                GradientStop { position: 0; color: "#4fc3f7" }
                GradientStop { position: 1; color: "#1565c0" }
            }
            startX: 20; startY: 220
            PathCubic { x: 180; y: 20;  control1X: 80;  control1Y: 200; control2X: 100; control2Y: 40 }
            PathCubic { x: 340; y: 220; control1X: 260; control1Y: 40;  control2X: 280; control2Y: 200 }
            PathLine  { x: 20;  y: 220 }
        }
    }

    Text {
        anchors { bottom: parent.bottom; horizontalCenter: parent.horizontalCenter; bottomMargin: 24 }
        text: "QtQuick.Shapes — cubic bezier with gradient"
        color: "#808080"
    }
}
