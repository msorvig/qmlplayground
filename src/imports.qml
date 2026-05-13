// Dummy file to ensure QML plugins are linked, and to pull in QML types
// referenced from playground examples. qmlimportscanner only links QML
// types it sees referenced in the project's own QML, so types we want
// users to be able to type (like ApplicationWindow / ToolBar) must be
// mentioned here — Component wrappers are enough; they don't instantiate.
import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Particles
import QtQuick.Shapes
import QtQuick.Effects
import QtQuick3D
import QtGraphs

Item {
    Component { ApplicationWindow {} }
    Component { ToolBar {} }
    Component { Label {} }
    Component { MenuBar {} }
    Component { TabBar {} }
}
