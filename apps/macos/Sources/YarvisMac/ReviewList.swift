import SwiftUI
import YarvisClient

/// The Review page's front page: paste a PR to review it, or pick up a
/// review workspace where it was left.
struct ReviewListView: View {
    @Bindable var model: ReviewModel
    @State private var archiving: ReviewWorkspace?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Review").font(.title2.weight(.semibold))
                Text("Paste a PR to check it out and review it in tabs. A PR already in a workspace opens there.")
                    .foregroundStyle(.secondary)
                PrLocatorField(model: model, actionLabel: "Open") { summary in
                    try await model.openPr(summary.ref, title: summary.title)
                }
                if let error = model.error {
                    Text(error).foregroundStyle(.red).textSelection(.enabled)
                }
                let shown = model.shownWorkspaces
                if shown.isEmpty && !model.listLoading {
                    Text("No review workspaces yet.").foregroundStyle(.secondary)
                }
                VStack(spacing: 2) {
                    ForEach(shown) { ws in
                        ReviewListRow(workspace: ws, open: { model.select(ws.id) }, archive: { archiving = ws })
                    }
                }
                Button(model.showArchived ? "Hide archived" : "Show archived") { model.showArchived.toggle() }
                    .buttonStyle(.link)
            }
            .frame(maxWidth: 820, alignment: .leading)
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear { model.loadRepos() }
        .sheet(item: $archiving) { ws in
            ReviewConfirmSheet(
                title: "Archive “\(ws.name)”?",
                message: "Removes the PRs' checkouts from disk and puts the workspace under Show archived. The "
                    + "clones are kept, so reviewing the same repos again starts faster.",
                action: "Archive", busyLabel: "Archiving…"
            ) { try await model.archive(ws.id) }
        }
    }
}

private struct ReviewListRow: View {
    let workspace: ReviewWorkspace
    let open: () -> Void
    let archive: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            Button(action: open) {
                HStack(spacing: 8) {
                    Text(workspace.name).fontWeight(.medium).lineLimit(1)
                    if workspace.prs.isEmpty {
                        Text("No PRs").font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(workspace.prs.sorted { $0.position < $1.position }) { pr in
                        HStack(spacing: 3) {
                            Circle().fill(reviewPrColor(pr.colorIndex)).frame(width: 6, height: 6)
                            Text(prLabel(pr.ref)).font(.caption.monospaced())
                        }
                    }
                    if workspace.status != "active" { WorkspaceStatusChip(status: workspace.status) }
                    Spacer()
                    Text(reviewOpenedAgo(workspace.lastOpenedAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .help(workspace.lastOpenedAt ?? "")
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if workspace.status == "active" {
                Button("Archive", action: archive)
                    .controlSize(.small)
                    .help("Remove the checkouts and put this workspace away")
                    .opacity(hovering ? 1 : 0)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(hovering ? Color.secondary.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 6))
        .onHover { hovering = $0 }
    }
}

/// The colours that tell a workspace's PRs apart. Indigo is left out
/// because it is the selection's colour.
let reviewPrColors: [Color] = [
    Color(red: 0.22, green: 0.74, blue: 0.97), Color(red: 0.98, green: 0.75, blue: 0.14),
    Color(red: 0.20, green: 0.83, blue: 0.60), Color(red: 0.98, green: 0.44, blue: 0.52),
    Color(red: 0.65, green: 0.55, blue: 0.98), Color(red: 0.64, green: 0.90, blue: 0.21),
    Color(red: 0.98, green: 0.57, blue: 0.24), Color(red: 0.18, green: 0.83, blue: 0.75),
]

func reviewPrColor(_ index: Int) -> Color {
    let n = reviewPrColors.count
    return reviewPrColors[((index % n) + n) % n]
}

/// The jump-to-PR field: a link or `owner/repo#12` in, the PR's summary out.
struct PrLocatorField: View {
    let model: ReviewModel
    let actionLabel: String
    let onOpen: (PrSummary) async throws -> Void
    @State private var input = ""
    @State private var candidates: [PrRef] = []
    @State private var error: String?
    @State private var opening = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                TextField("PR link, owner/repo#123, or repo#123", text: $input)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(submit)
                Button(opening ? "Opening…" : actionLabel, action: submit)
                    .disabled(opening || input.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if candidates.count > 1 {
                HStack {
                    Text("Several repos match — which one?").font(.caption)
                    ForEach(candidates, id: \.key) { ref in
                        Button("\(ref.displayRepo)#\(ref.number)") { open(ref) }.controlSize(.small)
                    }
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
        }
        .onAppear { model.loadRepos() }
    }

    private func submit() {
        guard !opening else { return }
        let refs = resolvePrLocator(input, knownRepos: model.knownRepos)
        candidates = refs
        switch refs.count {
        case 0: error = "Not a PR reference. Try a PR link, owner/repo#123, or repo#123."
        case 1: open(refs[0])
        default: error = nil
        }
    }

    private func open(_ ref: PrRef) {
        opening = true
        error = nil
        Task {
            defer { opening = false }
            do {
                let summary = try await model.client.prSummary(ref)
                try await onOpen(summary)
                input = ""
                candidates = []
            } catch {
                self.error = "Couldn't open \(prLabel(ref)): \(error.localizedDescription)"
            }
        }
    }
}

/// A confirm prompt whose action runs before it closes; a failure stays
/// open with the error. Cancel is the default button.
struct ReviewConfirmSheet: View {
    let title: String
    let message: String
    let action: String
    let busyLabel: String
    let run: () async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            Text(message).fixedSize(horizontal: false, vertical: true)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.defaultAction)
                Button(busy ? busyLabel : action, role: .destructive) {
                    busy = true
                    error = nil
                    Task {
                        defer { busy = false }
                        do {
                            try await run()
                            dismiss()
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                }
                .disabled(busy)
            }
        }
        .padding(20)
        .frame(width: 440)
    }
}
