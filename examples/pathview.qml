import QtQuick

Rectangle {
    anchors.fill: parent
    color: "#1e1e1e"

    PathView {
        id: view
        anchors.fill: parent
        model: 12
        pathItemCount: 12
        interactive: true

        delegate: Rectangle {
            width: 80; height: 80
            radius: 10
            color: Qt.hsva(index / 12, 0.6, 0.9, 1.0)
            border.color: "white"; border.width: 2
            scale: PathView.itemScale ?? 1.0
            opacity: PathView.itemOpacity ?? 1.0
            Text {
                anchors.centerIn: parent
                text: index + 1
                color: "white"
                font.pixelSize: 24
                font.bold: true
            }
        }

        path: Path {
            startX: 120; startY: 240
            PathAttribute { name: "itemScale";   value: 0.5 }
            PathAttribute { name: "itemOpacity"; value: 0.3 }
            PathArc { x: 600; y: 240; radiusX: 240; radiusY: 100; direction: PathArc.Clockwise }
            PathAttribute { name: "itemScale";   value: 1.2 }
            PathAttribute { name: "itemOpacity"; value: 1.0 }
            PathArc { x: 120; y: 240; radiusX: 240; radiusY: 100; direction: PathArc.Clockwise }
            PathAttribute { name: "itemScale";   value: 0.5 }
            PathAttribute { name: "itemOpacity"; value: 0.3 }
        }

        NumberAnimation on offset {
            from: 0; to: 12
            duration: 12000
            loops: Animation.Infinite
        }
    }
}
