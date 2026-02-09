import QtQuick
import QtQuick3D

Rectangle {
    anchors.fill: parent
    color: "#1a1a2e"

    View3D {
        anchors.fill: parent

        environment: SceneEnvironment {
            clearColor: "#1a1a2e"
            backgroundMode: SceneEnvironment.Color
            antialiasingMode: SceneEnvironment.MSAA
        }

        PerspectiveCamera {
            z: 400
        }

        DirectionalLight {
            eulerRotation.x: -30
            eulerRotation.y: -30
        }

        Model {
            source: "#Cube"
            scale: Qt.vector3d(1.5, 1.5, 1.5)
            materials: PrincipledMaterial {
                baseColor: "#0e639c"
                metalness: 0.5
                roughness: 0.3
            }

            NumberAnimation on eulerRotation.y {
                from: 0; to: 360
                duration: 4000
                loops: Animation.Infinite
            }

            NumberAnimation on eulerRotation.x {
                from: 0; to: 360
                duration: 6000
                loops: Animation.Infinite
            }
        }
    }

    Text {
        anchors.bottom: parent.bottom
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottomMargin: 20
        text: "Qt Quick 3D"
        color: "#808080"
        font.pixelSize: 14
    }
}
