import SwiftUI

struct TerminalsView: View {
    @Bindable var model: TerminalsModel

    var body: some View {
        TerminalSurfaceView(model: model.surface)
    }
}
