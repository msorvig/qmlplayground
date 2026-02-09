import QtQuick
import QtQuick3D

Rectangle {
    anchors.fill: parent
    color: "#0d1117"

    View3D {
        anchors.fill: parent

        environment: SceneEnvironment {
            clearColor: "#0d1117"
            backgroundMode: SceneEnvironment.Color
        }

        PerspectiveCamera {
            z: 500
        }

        DirectionalLight {
            eulerRotation.x: -45
            brightness: 1.0
        }

        PointLight {
            position: Qt.vector3d(200, 200, 200)
            brightness: 0.5
        }

        Model {
            source: "#Sphere"
            scale: Qt.vector3d(2, 2, 2)
            materials: PrincipledMaterial {
                baseColor: "#e74c3c"
                metalness: 0.8
                roughness: 0.2
            }

            NumberAnimation on eulerRotation.y {
                from: 0; to: 360
                duration: 8000
                loops: Animation.Infinite
            }
        }
    }
}
