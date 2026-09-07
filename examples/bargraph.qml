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
            seriesColors: ["#0e639c", "#4ec9b0", "#cca700"]
        }

        BarSeries {
            axisX: BarCategoryAxis {
                categories: ["2021", "2022", "2023", "2024"]
            }
            axisY: ValueAxis {
                min: 0
                max: 100
            }

            BarSet { label: "Sales"; values: [45, 62, 78, 91] }
            BarSet { label: "Profit"; values: [25, 38, 52, 67] }
        }
    }
}
