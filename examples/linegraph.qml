import QtQuick
import QtGraphs

Rectangle {
    anchors.fill: parent
    color: "#1e1e1e"

    GraphsView {
        anchors.fill: parent
        anchors.margins: 16

        theme: GraphsTheme {
            colorScheme: GraphsTheme.ColorScheme.Dark
            seriesColors: ["#4ec9b0", "#0e639c", "#cca700"]
        }

        LineSeries {
            name: "Temperature"
            axisX: ValueAxis { min: 0; max: 6; tickInterval: 1 }
            axisY: ValueAxis { min: 0; max: 30 }

            XYPoint { x: 0; y: 15 }
            XYPoint { x: 1; y: 18 }
            XYPoint { x: 2; y: 22 }
            XYPoint { x: 3; y: 25 }
            XYPoint { x: 4; y: 23 }
            XYPoint { x: 5; y: 20 }
            XYPoint { x: 6; y: 17 }
        }
    }
}
