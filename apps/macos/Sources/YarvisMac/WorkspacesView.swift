import SwiftUI
import YarvisClient

struct WorkspacesView: View {
    @Bindable var model: WorkspacesModel

    var body: some View {
        HSplitView {
            List(model.workspaces, selection: $model.selectedId) { ws in
                Text(ws.name).tag(ws.id)
            }
            .frame(minWidth: 200, idealWidth: 240, maxWidth: 360)
            Text("Select a workspace or create a new one.")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
