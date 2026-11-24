import SwiftUI
import YarvisClient

/// The Review page: the workspace list, or the open workspace.
struct ReviewView: View {
    @Bindable var model: ReviewModel

    var body: some View {
        Group {
            if let workspace = model.workspace {
                ReviewWorkspaceView(model: workspace, back: { model.select(nil) })
            } else {
                ReviewListView(model: model)
            }
        }
        .onAppear { model.appeared() }
    }
}

struct ReviewListView: View {
    @Bindable var model: ReviewModel

    var body: some View {
        List(model.workspaces) { ws in
            Button(ws.name) { model.select(ws.id) }.buttonStyle(.plain)
        }
        .overlay {
            if let error = model.error { Text(error).foregroundStyle(.red) }
        }
    }
}

struct ReviewWorkspaceView: View {
    @Bindable var model: ReviewWorkspaceModel
    let back: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Button("All review workspaces", systemImage: "chevron.left", action: back)
                Text(model.workspace?.name ?? "").font(.headline)
                Spacer()
            }
            .padding(8)
            Divider()
            if let spec = model.tabs.first(where: { $0.id == model.activeTabId }), let pr = model.prs[spec.prId] {
                ReviewTabBody(spec: spec, context: ReviewTabContext(workspace: model, pr: pr))
            } else {
                Text(model.error ?? "Pick a section or a file on the left.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}
