import SwiftUI
import YarvisClient

struct WorkspaceDetailView: View {
    @Bindable var model: WorkspaceDetailModel

    var body: some View {
        if let detail = model.detail {
            VStack(alignment: .leading, spacing: 0) {
                WorkspaceHeader(model: model, detail: detail)
                    .padding(10)
                Divider()
                let actions = provisionActions(detail)
                if model.detailLoaded, actions.show, model.provisionLog == nil {
                    ProvisionActionBar(model: model, detail: detail, actions: actions)
                    Divider()
                }
                WorkspaceBody(model: model, detail: detail)
            }
            .sheet(isPresented: $model.showArchive) {
                ArchiveSheet(model: model, detail: detail)
            }
        } else if let error = model.loadError {
            Text(error).foregroundStyle(.red).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - Header

private struct WorkspaceHeader: View {
    @Bindable var model: WorkspaceDetailModel
    let detail: WorkspaceDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                WorkspaceNameHeading(name: detail.name, rename: model.rename)
                WorkspaceStatusChip(status: detail.status)
                Spacer(minLength: 8)
                Text(detail.rootPath)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                CopyButton(text: detail.rootPath, help: "Copy the workspace's path")
            }
            HStack(spacing: 8) {
                if let error = model.agentError {
                    Text(error).font(.caption).foregroundStyle(.red).lineLimit(2)
                }
                Spacer()
                if model.showsHarnessPicker {
                    Picker("Agent harness", selection: Binding(
                        get: { chosenHarness(model.agentConfig, picked: model.pickedHarness)?.id ?? "" },
                        set: { model.pickedHarness = $0 })) {
                        ForEach(model.agentConfig.harnesses) { Text($0.name).tag($0.id) }
                    }
                    .labelsHidden()
                    .fixedSize()
                }
                if model.showsStartButton {
                    Button(model.startButtonLabel, action: model.startAgent)
                        .disabled(model.startingAgent)
                }
                if !detail.isArchived {
                    let label = archiveButtonLabel(detail)
                    Button(label) { model.showArchive = true }
                        .disabled(label == "Archiving…")
                }
            }
            if let note = model.agentConfigError {
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
            if !detail.repos.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(detail.repos) { RepoChip(model: model, repo: $0) }
                    }
                }
            }
            if detail.isActive, !detail.readyRepos.isEmpty {
                PrBlock(model: model, detail: detail)
            }
            LinkedWorkRows(model: model, detail: detail)
            if let error = model.actionError {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
    }
}

/// The name, with an inline rename. Enter or leaving the field saves,
/// Escape cancels, and a failure keeps the field open.
private struct WorkspaceNameHeading: View {
    let name: String
    let rename: (String) async -> String?
    @State private var editing = false
    @State private var draft = ""
    @State private var error: String?
    @State private var saving = false
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 6) {
            if editing {
                TextField("Name", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .frame(minWidth: 200, maxWidth: 360)
                    .focused($focused)
                    .onSubmit(save)
                    .onExitCommand {
                        editing = false
                        error = nil
                    }
                    .onChange(of: draft) { _, new in
                        if new.count > 200 { draft = String(new.prefix(200)) }
                    }
                    .onChange(of: focused) { _, isFocused in
                        if !isFocused && editing { save() }
                    }
                    .disabled(saving)
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
            } else {
                Text(name).font(.title3.weight(.semibold)).lineLimit(1)
                Button("Rename") {
                    draft = name
                    error = nil
                    editing = true
                    focused = true
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .help("Rename this workspace. Its folder and branch keep their current names.")
            }
        }
    }

    private func save() {
        guard !saving else { return }
        saving = true
        Task {
            defer { saving = false }
            if let failure = await rename(draft) {
                error = failure
            } else {
                editing = false
                error = nil
            }
        }
    }
}

private struct RepoChip: View {
    let model: WorkspaceDetailModel
    let repo: WorkspaceRepoDetail

    var body: some View {
        HStack(spacing: 5) {
            Text(repo.repo.name).font(.caption.weight(.medium))
            Text(repo.branch).font(.caption.monospaced()).foregroundStyle(.secondary)
            RepoStatusChip(status: repo.status)
            CopyButton(text: repo.worktreePath, help: "Copy the worktree's path")
            if repo.status == "error" {
                Button("Setup log") { model.openTab(.setupLog(repo: repo.id)) }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.red)
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - PRs

private struct PrBlock: View {
    let model: WorkspaceDetailModel
    let detail: WorkspaceDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(detail.readyRepos) { repo in
                RepoPrStatus(model: model, repo: repo, showName: detail.repos.count > 1)
            }
            HStack(spacing: 8) {
                Button("Detect PRs again", action: model.detectPrs)
                    .controlSize(.small)
                    .disabled(model.detecting)
                if let note = model.detectNote {
                    Text(note.text).font(.caption).foregroundStyle(note.isError ? .red : .secondary)
                }
            }
        }
    }
}

private struct RepoPrStatus: View {
    let model: WorkspaceDetailModel
    let repo: WorkspaceRepoDetail
    let showName: Bool

    var body: some View {
        let prs = (repo.prs ?? []).filter { $0.prNumber != nil }
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if showName { Text(repo.repo.name).font(.caption.weight(.medium)) }
                if prs.isEmpty {
                    Text(repo.prsPolledAt != nil ? "No PR yet" : "PR not polled yet")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let error = repo.prsPollError {
                    Text("Couldn't search for PRs: \(error)").font(.caption).foregroundStyle(.red)
                }
                if let sync = model.sync[repo.id] {
                    ForEach(syncChips(sync), id: \.text) { chip in
                        Chip(text: chip.text, color: chip.isPull ? .orange : .secondary)
                    }
                }
                LinkPrControl(model: model, workspaceRepoId: repo.id)
                if let error = model.prErrors[repo.id] {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }
            ForEach(prs, id: \.prNumber) { pr in
                PrRow(model: model, repo: repo, pr: pr)
            }
        }
    }
}

private struct PrRow: View {
    let model: WorkspaceDetailModel
    let repo: WorkspaceRepoDetail
    let pr: WorkspaceRepoPr
    @State private var openingReview = false
    @State private var reviewError: String?

    private func openInReview(_ number: Int) {
        guard let review = model.app.review else { return }
        let ref = linkedPrRef(url: pr.prUrl, owner: repo.repo.owner, repo: repo.repo.repo, number: number)
        openingReview = true
        reviewError = nil
        Task {
            defer { openingReview = false }
            do { try await review.openPr(ref) } catch { reviewError = error.localizedDescription }
        }
    }

    var body: some View {
        let number = pr.prNumber ?? 0
        let state = pr.prState ?? "open"
        HStack(spacing: 6) {
            Text("#\(number)").font(.caption.monospaced())
            Chip(text: state, color: prStateColor(state))
            if pr.isDraft == true { Chip(text: "draft") }
            if let head = pr.headBranch, head != repo.branch {
                Text(head).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            Text(checksLabel(pr.checkRollup)).font(.caption).foregroundStyle(checksColor(pr.checkRollup))
            if hasConflicts(pr.mergeable) { Chip(text: "⚠ merge conflicts", color: .red) }
            Button(openingReview ? "Opening…" : "Open in review workspace") { openInReview(number) }
                .buttonStyle(.borderless).controlSize(.small)
                .disabled(openingReview)
            if let reviewError { Text(reviewError).font(.caption).foregroundStyle(.red) }
            if let url = pr.prUrl {
                Button("Open ↗") { openExternal(url) }
                    .buttonStyle(.borderless).controlSize(.small)
                CopyButton(text: url, help: "Copy the PR's link")
            }
            Button("Unlink") { model.unlinkPr(repo: repo.id, number: number) }
                .buttonStyle(.borderless).controlSize(.small)
        }
        .opacity(state.lowercased() == "closed" ? 0.6 : 1)
    }
}

private struct LinkPrControl: View {
    let model: WorkspaceDetailModel
    let workspaceRepoId: String
    @State private var open = false
    @State private var input = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        if open {
            HStack(spacing: 4) {
                TextField("PR #", text: $input)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 70)
                    .onSubmit(link)
                    .onExitCommand(perform: close)
                Button("Link", action: link).controlSize(.small).disabled(busy)
                Button("Cancel", action: close).controlSize(.small)
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
            }
        } else {
            Button("Link PR") { open = true }
                .buttonStyle(.borderless).controlSize(.small)
        }
    }

    private func close() {
        open = false
        input = ""
        error = nil
    }

    private func link() {
        busy = true
        Task {
            defer { busy = false }
            if let failure = await model.linkPr(repo: workspaceRepoId, input: input) {
                error = failure
            } else {
                close()
            }
        }
    }
}

private struct LinkedWorkRows: View {
    let model: WorkspaceDetailModel
    let detail: WorkspaceDetail

    var body: some View {
        let archived = detail.isArchived
        if !detail.tasks.isEmpty {
            HStack(spacing: 8) {
                ForEach(detail.tasks) { task in
                    HStack(spacing: 2) {
                        Text("\(task.status == "done" ? "✓" : "○") \(task.title)")
                            .font(.caption)
                            .foregroundStyle(task.status == "done" ? .green : .primary)
                        if !archived {
                            Button("×") { model.unlinkTask(task) }.buttonStyle(.borderless).help("Unlink this task")
                        }
                    }
                }
            }
        }
        if !detail.issues.isEmpty {
            HStack(spacing: 8) {
                ForEach(detail.issues) { issue in
                    HStack(spacing: 3) {
                        Chip(text: issue.provider)
                        let title = issue.title ?? issue.externalId
                        if issue.url != nil {
                            Button(title) { openExternal(issue.url) }.buttonStyle(.link).font(.caption)
                        } else {
                            Text(title).font(.caption)
                        }
                        if !archived {
                            Button("×") { model.unlinkIssue(issue) }.buttonStyle(.borderless).help("Unlink this issue")
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Provisioning

private struct ProvisionActionBar: View {
    let model: WorkspaceDetailModel
    let detail: WorkspaceDetail
    let actions: ProvisionActions

    var body: some View {
        HStack(spacing: 8) {
            Button(actions.label, action: model.provision)
            if actions.showIgnore {
                Button("Ignore and use anyway", action: model.ignoreFailure)
                if let error = model.ignoreError {
                    Text(error).font(.caption).foregroundStyle(.red)
                } else if let error = detail.error {
                    Text(error).font(.caption).foregroundStyle(.red).lineLimit(3)
                }
            }
            if let error = model.provisionError {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            Spacer()
        }
        .padding(10)
    }
}

/// A monospaced log that keeps its end in view as it grows.
struct LogPane: View {
    let text: String

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(text.isEmpty ? "Starting…" : text)
                    .font(.caption.monospaced())
                    .foregroundStyle(text.isEmpty ? .secondary : .primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                Color.clear.frame(height: 1).id("end")
            }
            .onChange(of: text) { proxy.scrollTo("end", anchor: .bottom) }
        }
    }
}

// MARK: - Body

private struct WorkspaceBody: View {
    @Bindable var model: WorkspaceDetailModel
    let detail: WorkspaceDetail

    var body: some View {
        if let log = model.provisionLog {
            LogPane(text: log)
        } else if detail.isArchived {
            ArchivedView(detail: detail)
        } else {
            HSplitView {
                WorkspaceMainTabs(model: model)
                    .frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
                Group {
                    if detail.isTearingDown {
                        Text("Removing worktrees…")
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        WorkspaceSidePanel(model: model)
                    }
                }
                .frame(minWidth: 220, idealWidth: 300, maxWidth: 520, maxHeight: .infinity)
            }
        }
    }
}

private struct ArchivedView: View {
    let detail: WorkspaceDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("This workspace is archived. Its worktrees have been removed.")
                .foregroundStyle(.secondary)
            if let summary = detail.summary, !summary.isEmpty {
                GroupBox("Summary") {
                    Text(summary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if let url = detail.mergedPrUrl, !url.isEmpty {
                Button(url) { openExternal(url) }.buttonStyle(.link)
            }
            ForEach(detail.tasks) { task in
                Text("\(task.status == "done" ? "✓" : "○") \(task.title)")
            }
            Spacer()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct WorkspaceMainTabs: View {
    @Bindable var model: WorkspaceDetailModel

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(model.tabs) { tab in
                        HStack(spacing: 4) {
                            Button(model.tabTitle(tab)) { model.select(tab) }
                                .buttonStyle(.borderless)
                                .fontWeight(model.selectedTab == tab ? .semibold : .regular)
                            if tab != .terminals {
                                Button {
                                    model.closeTab(tab)
                                } label: {
                                    Image(systemName: "xmark").font(.caption2)
                                }
                                .buttonStyle(.borderless)
                            }
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(model.selectedTab == tab ? Color.secondary.opacity(0.15) : .clear,
                                    in: RoundedRectangle(cornerRadius: 5))
                    }
                }
                .padding(4)
            }
            Divider()
            content(model.selectedTab)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder private func content(_ tab: WorkspaceTab) -> some View {
        switch tab {
        case .terminals:
            if let surface = model.surface {
                TerminalSurfaceView(model: surface)
            } else {
                Spacer()
            }
        case .diff:
            if let diff = model.diffs[tab] { WorkspaceDiffView(model: diff, detail: model).id(tab) }
        case .editor:
            if let editor = model.editors[tab] { WorkspaceEditorView(model: editor).id(tab) }
        case .setupLog(let repo):
            let wr = model.repo(repo)
            VStack(alignment: .leading, spacing: 0) {
                if let error = wr?.error {
                    Text(error).font(.caption).foregroundStyle(.red).padding(8)
                }
                if let code = wr?.setupExitCode {
                    Text("exit code \(code)").font(.caption).foregroundStyle(.secondary).padding(.horizontal, 8)
                }
                LogPane(text: wr?.setupLog ?? "No setup output.")
            }
        }
    }
}
