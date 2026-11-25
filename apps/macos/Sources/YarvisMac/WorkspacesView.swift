import SwiftUI
import YarvisClient

struct WorkspacesView: View {
    @Bindable var model: WorkspacesModel

    var body: some View {
        HSplitView {
            WorkspaceListColumn(model: model)
                .frame(minWidth: 220, idealWidth: 280, maxWidth: 420)
            Group {
                if let form = model.newWorkspace {
                    NewWorkspaceView(model: form, onCancel: model.cancelNewWorkspace)
                } else if let detail = model.detail {
                    WorkspaceDetailView(model: detail).id(detail.id)
                } else {
                    Text("Select a workspace or create a new one.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(minWidth: 500, maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { model.appeared() }
    }
}

private struct WorkspaceListColumn: View {
    @Bindable var model: WorkspacesModel

    var body: some View {
        let groups = model.shownGroups
        let attention = model.attentionIds
        VStack(spacing: 0) {
            HStack {
                Text("Workspaces").font(.headline)
                if model.refreshing { ProgressView().controlSize(.mini) }
                Spacer()
                Button("New") { model.startNewWorkspace() }
                    .controlSize(.small)
            }
            .padding(8)
            if let error = model.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
            }
            if groups.isEmpty {
                Text(model.showArchived || model.archivedCount == 0 ? "No workspaces yet." : "No active workspaces.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(selection: $model.selectedId) {
                    ForEach(groups) { group in
                        SwiftUI.Section(group.label.uppercased()) {
                            ForEach(group.workspaces) { ws in
                                WorkspaceRow(ws: ws, needsYou: attention.contains(ws.id),
                                             selected: model.selectedId == ws.id)
                                    .tag(ws.id)
                            }
                        }
                    }
                }
                .listStyle(.sidebar)
            }
            if model.archivedCount > 0 {
                Button(model.showArchived ? "Hide archived" : "Show archived (\(model.archivedCount))") {
                    model.showArchived.toggle()
                }
                .buttonStyle(.borderless)
                .font(.caption)
                .padding(6)
            }
        }
    }
}

private struct WorkspaceRow: View {
    let ws: WorkspaceSummary
    let needsYou: Bool
    let selected: Bool

    var body: some View {
        let idle = idleDays(ws)
        HStack(spacing: 6) {
            if needsYou {
                Circle().fill(.orange).frame(width: 6, height: 6)
            }
            Text(ws.name)
                .lineLimit(1)
                .truncationMode(.tail)
                .opacity(idle == nil ? 1 : 0.6)
                .foregroundStyle(needsYou && !selected ? AnyShapeStyle(.orange) : AnyShapeStyle(.primary))
            Spacer(minLength: 4)
            if let idle {
                Text("idle \(idle)d")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .help("Not opened and no agent activity for \(idle) days — archive it if the work is done")
            }
            ForEach(Array((ws.prs ?? []).enumerated()), id: \.offset) { _, pr in
                PrGlanceBadge(pr: pr)
            }
            WorkspaceStatusChip(status: ws.status)
        }
        .help(needsYou ? "\(ws.name) — needs you" : ws.name)
    }
}
