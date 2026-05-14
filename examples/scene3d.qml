import QtQuick
import QtQuick3D

View3D {
    anchors.fill: parent
    environment: SceneEnvironment {
        clearColor: "#1e1e1e"
        backgroundMode: SceneEnvironment.Color
        antialiasingMode: SceneEnvironment.MSAA
        antialiasingQuality: SceneEnvironment.High
    }

    PerspectiveCamera {
        position: Qt.vector3d(0, 200, 500)
        eulerRotation: Qt.vector3d(-20, 0, 0)
    }

    DirectionalLight {
        eulerRotation: Qt.vector3d(-45, -30, 0)
        brightness: 1.5
    }

    Node {
        id: scene

        Model {
            source: "#Sphere"
            position: Qt.vector3d(0, 0, 0)
            scale: Qt.vector3d(1.5, 1.5, 1.5)
            materials: PrincipledMaterial {
                baseColor: "#4fc3f7"
                metalness: 0.7
                roughness: 0.2
            }
        }

        Repeater3D {
            model: 6
            Model {
                source: "#Cube"
                position: Qt.vector3d(
                    220 * Math.cos(index * 2 * Math.PI / 6),
                    0,
                    220 * Math.sin(index * 2 * Math.PI / 6))
                scale: Qt.vector3d(0.5, 0.5, 0.5)
                materials: PrincipledMaterial {
                    baseColor: Qt.hsva(index / 6, 0.7, 0.9, 1.0)
                    roughness: 0.5
                }
            }
        }

        NumberAnimation on eulerRotation.y {
            from: 0; to: 360
            duration: 12000
            loops: Animation.Infinite
        }
    }
}
