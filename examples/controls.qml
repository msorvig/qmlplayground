import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    anchors.fill: parent
    color: "#1e1e1e"

    ColumnLayout {
        anchors.centerIn: parent
        spacing: 16

        Label {
            text: "Qt Quick Controls"
            font.pixelSize: 24
            color: "white"
            Layout.alignment: Qt.AlignHCenter
        }

        Slider {
            id: slider
            from: 0; to: 100; value: 50
            Layout.preferredWidth: 200
        }

        Label {
            text: "Value: " + slider.value.toFixed(0)
            color: "#808080"
            Layout.alignment: Qt.AlignHCenter
        }

        RowLayout {
            spacing: 8
            Layout.alignment: Qt.AlignHCenter

            Button {
                text: "Button"
                onClicked: slider.value = 50
            }

            Switch {
                text: "Switch"
            }
        }

        ProgressBar {
            value: slider.value / 100
            Layout.preferredWidth: 200
        }
    }
}
