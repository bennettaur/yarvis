import SwiftUI
import YarvisClient

/// Archives a workspace: an optional summary and PR link, which linked
/// issues to close, and Force remove when a dirty worktree stopped it.
struct ArchiveSheet: View {
    let model: WorkspaceDetailModel
    let detail: WorkspaceDetail
    @Environment(\.dismiss) private var dismiss
    @State private var summary = ""
    @State private var prUrl = ""
    @State private var closing: Set<String> = []
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let openTasks = detail.tasks.filter { $0.status != "done" }.count
        let unfinished = detail.issues.filter { $0.localStatus != "done" }
        let blocked = archiveBlockedText(detail)
        VStack(alignment: .leading, spacing: 10) {
            Text("Archive “\(detail.name)”").font(.headline)
            Text("Removes the workspace folder and its worktrees from disk"
                + (openTasks > 0 ? " and marks \(openTasks) linked task\(openTasks == 1 ? "" : "s") done" : "")
                + ". Runs in the background — you can keep working while it finishes.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Summary").font(.caption.weight(.medium))
            TextEditor(text: $summary)
                .frame(height: 60)
                .border(.quaternary)
                .overlay(alignment: .topLeading) {
                    if summary.isEmpty {
                        Text("What was done to complete the task")
                            .foregroundStyle(.tertiary).padding(5).allowsHitTesting(false)
                    }
                }
            Text("PR URL").font(.caption.weight(.medium))
            TextField("https://github.com/owner/repo/pull/123", text: $prUrl)
                .textFieldStyle(.roundedBorder)
            if !unfinished.isEmpty {
                Text("Close linked issues").font(.caption.weight(.medium))
                ForEach(unfinished) { issue in
                    Toggle(isOn: Binding(get: { closing.contains(issue.id) }, set: { on in
                        if on { closing.insert(issue.id) } else { closing.remove(issue.id) }
                    })) {
                        Text("\(issueLinkLabel(issue)) \(issue.title ?? "")").lineLimit(1)
                    }
                }
            }
            if let blocked { Text(blocked).font(.caption).foregroundStyle(.red) }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                if blocked != nil {
                    Button("Force remove") { archive(force: true, unfinished: unfinished) }
                        .tint(.red)
                        .disabled(busy)
                } else {
                    Button(busy ? "Archiving…" : "Archive") { archive(force: false, unfinished: unfinished) }
                        .keyboardShortcut(.defaultAction)
                        .disabled(busy)
                }
            }
        }
        .padding(16)
        .frame(width: 460)
        .onAppear {
            summary = detail.summary ?? ""
            prUrl = archivePrefillPrUrl(detail)
            closing = Set(unfinishedIds)
        }
    }

    private var unfinishedIds: [String] { detail.issues.filter { $0.localStatus != "done" }.map(\.id) }

    private func archive(force: Bool, unfinished: [IssueLink]) {
        func trimmed(_ s: String) -> String? {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        let request = ArchiveRequest(summary: trimmed(summary), mergedPrUrl: trimmed(prUrl), force: force,
                                     closeIssueIds: unfinished.map(\.id).filter { closing.contains($0) })
        busy = true
        Task {
            defer { busy = false }
            if let failure = await model.archive(request) {
                error = failure
            } else {
                dismiss()
            }
        }
    }
}

/// The new-workspace form, then its provision log.
struct NewWorkspaceView: View {
    @Bindable var model: NewWorkspaceModel
    let onCancel: () -> Void

    var body: some View {
        if let name = model.provisioningName {
            VStack(alignment: .leading, spacing: 8) {
                Text("Provisioning “\(name)”…").font(.headline)
                if let error = model.error { Text(error).foregroundStyle(.red) }
                LogPane(text: model.log)
                    .background(.quaternary.opacity(0.3))
            }
            .padding(16)
        } else {
            form
        }
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("New workspace").font(.title3.weight(.semibold))
                VStack(alignment: .leading, spacing: 4) {
                    Text("Name").font(.caption.weight(.medium))
                    TextField("rename the API", text: $model.name)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(model.create)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Repos (optional)").font(.caption.weight(.medium))
                    if let error = model.reposError {
                        Text(error).font(.caption).foregroundStyle(.red)
                    } else if model.repos.isEmpty {
                        Text("No repos registered. Add one in Settings → Repositories.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(model.repos) { repo in
                        RepoPickRow(model: model, repo: repo)
                    }
                    Text("Leave empty for a scratch workspace — just a folder to run an agent in, for experimentation and exploration.")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !model.tasks.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Picker("Link a task (optional)", selection: $model.taskId) {
                            Text("None").tag(String?.none)
                            ForEach(model.tasks) { Text($0.title).tag(Optional($0.id)) }
                        }
                        Text("Archiving the workspace will mark a linked task done.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let error = model.error { Text(error).font(.caption).foregroundStyle(.red) }
                HStack {
                    Button("Cancel", action: onCancel).keyboardShortcut(.cancelAction)
                    Button("Create", action: model.create)
                        .keyboardShortcut(.defaultAction)
                        .disabled(model.busy)
                }
            }
            .padding(16)
            .frame(maxWidth: 560, alignment: .leading)
        }
    }
}

private struct RepoPickRow: View {
    @Bindable var model: NewWorkspaceModel
    let repo: Repo
    @State private var filter = ""

    var body: some View {
        HStack(spacing: 8) {
            Toggle(isOn: Binding(get: { model.ticked.contains(repo.id) }, set: { _ in model.toggle(repo) })) {
                HStack(spacing: 6) {
                    Text(repo.name)
                    Text(repo.fullName).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if model.ticked.contains(repo.id) { branchPicker }
        }
    }

    @ViewBuilder private var branchPicker: some View {
        switch model.branches[repo.id] {
        case .loaded(let branches)?:
            let shown = filter.isEmpty ? branches : branches.filter { $0.localizedCaseInsensitiveContains(filter) }
            if branches.count > 12 {
                TextField("Filter branches", text: $filter)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 120)
            }
            Picker("Branch", selection: Binding(
                get: { model.chosenBranch[repo.id] ?? "" }, set: { model.chosenBranch[repo.id] = $0 })) {
                Text("New branch").tag("")
                ForEach(shown, id: \.self) { Text($0).tag($0) }
                // Keeps a pick the filter now hides selectable, so the menu still shows it.
                if let picked = model.chosenBranch[repo.id], !picked.isEmpty, !shown.contains(picked) {
                    Text(picked).tag(picked)
                }
            }
            .labelsHidden()
            .frame(maxWidth: 220)
        case .failed(let error)?:
            Text(error).font(.caption).foregroundStyle(.red).lineLimit(1)
            Button("retry") { model.loadBranches(repo.id) }.buttonStyle(.link)
        case .loading?, nil:
            Text("loading…").font(.caption).foregroundStyle(.secondary)
        }
    }
}
