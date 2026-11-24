import SwiftUI
import YarvisClient

struct WorkspaceSidePanel: View {
    @Bindable var model: WorkspaceDetailModel

    var body: some View {
        let ready = model.detail?.repos.filter { $0.status == "ready" } ?? []
        VStack(alignment: .leading, spacing: 6) {
            WorktreePicker(model: model, ready: ready)
            Picker("View", selection: $model.sideTab) {
                ForEach(WorkspaceSideTab.allCases) { tab in
                    if tab == .comments, model.openCommentCount > 0 {
                        Text("Comments (\(model.openCommentCount))").tag(tab)
                    } else {
                        Text(tab.rawValue).tag(tab)
                    }
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            Group {
                switch model.sideTab {
                case .comments:
                    CommentsView(model: model)
                case .checks:
                    if model.sideWorktree != nil {
                        Text("PR checks show for the workspace's own worktree.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else if let repo = model.sideRepo {
                        PrChecksView(repo: repo)
                    } else {
                        noRepo
                    }
                case .changed:
                    if let repo = model.sideRepo { ChangesView(model: model, repo: repo) } else { noRepo }
                case .files:
                    if let repo = model.sideRepo { FilesView(model: model, repo: repo) } else { noRepo }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .padding(8)
    }

    private var noRepo: some View {
        Text("No worktree is ready yet.").font(.caption).foregroundStyle(.secondary)
    }
}

/// Picks the repo and worktree the panel reads, when there is more than one.
private struct WorktreePicker: View {
    @Bindable var model: WorkspaceDetailModel
    let ready: [WorkspaceRepoDetail]

    var body: some View {
        let options = ready.map { ($0, model.worktreeOptions($0)) }
        let total = options.reduce(0) { $0 + $1.1.count }
        VStack(alignment: .leading, spacing: 3) {
            if total > 1 {
                Picker("Worktree", selection: $model.sideSelection) {
                    ForEach(options, id: \.0.id) { repo, worktrees in
                        SwiftUI.Section(repo.repo.name) {
                            ForEach(worktrees, id: \.path) { wt in
                                Text((wt.branch ?? "detached HEAD") + (wt.primary ? " (workspace branch)" : ""))
                                    .tag("\(repo.id)|\(wt.path)")
                            }
                        }
                    }
                }
                .labelsHidden()
            }
            if let path = model.sideWorktree, let repo = model.sideRepo {
                let branch = model.worktreeOptions(repo).first { $0.path == path }?.branch ?? "detached HEAD"
                HStack(spacing: 4) {
                    Text("Viewing \(ready.count > 1 ? "\(repo.repo.name) · " : "")\(branch)")
                        .font(.caption).foregroundStyle(.secondary)
                    CopyButton(text: path, help: "Copy the worktree's path")
                }
            }
            if model.worktreeListingFailed {
                Text("Couldn't look for other worktrees of this repo.").font(.caption).foregroundStyle(.tertiary)
            }
        }
    }
}

// MARK: - Files and changes

/// A folder tree of relative paths, with `row` drawing each file.
private struct FileTree<Row: View>: View {
    let nodes: [FileTreeNode]
    let expandedByDefault: Bool
    @ViewBuilder let row: (FileTreeNode) -> Row

    var body: some View {
        ForEach(nodes) { node in
            if let children = node.children {
                FolderRow(node: node, children: children, expandedByDefault: expandedByDefault, row: row)
            } else {
                row(node)
            }
        }
    }
}

private struct FolderRow<Row: View>: View {
    let node: FileTreeNode
    let children: [FileTreeNode]
    let expandedByDefault: Bool
    let row: (FileTreeNode) -> Row
    @State private var expanded: Bool?

    var body: some View {
        DisclosureGroup(isExpanded: Binding(get: { expanded ?? expandedByDefault }, set: { expanded = $0 })) {
            AnyView(FileTree(nodes: children, expandedByDefault: expandedByDefault, row: row))
        } label: {
            Label(node.name, systemImage: "folder").font(.callout)
        }
    }
}

private func changeLetter(_ status: String) -> (String, Color) {
    switch status {
    case "added": return ("A", .green)
    case "modified": return ("M", .orange)
    case "deleted": return ("D", .red)
    case "renamed": return ("R", .indigo)
    case "untracked": return ("U", .secondary)
    default: return ("?", .secondary)
    }
}

private struct ChangesView: View {
    let model: WorkspaceDetailModel
    let repo: WorkspaceRepoDetail

    var body: some View {
        let changes = model.sideKey.flatMap { model.changes[$0] }
        let byPath = Dictionary((changes ?? []).map { ($0.path, $0) }, uniquingKeysWith: { a, _ in a })
        VStack(alignment: .leading, spacing: 4) {
            if let changes {
                HStack {
                    Text("\(changes.count) changed file\(changes.count == 1 ? "" : "s")").font(.caption)
                    CopyButton(text: changes.map(\.path).joined(separator: "\n"), help: "Copy the changed paths")
                }
                if changes.isEmpty {
                    Text("No changes on this branch.").font(.caption).foregroundStyle(.secondary)
                }
                List {
                    FileTree(nodes: buildFileTree(changes.map(\.path)), expandedByDefault: true) { node in
                        if let change = byPath[node.path] {
                            ChangeRow(model: model, repo: repo, change: change, name: node.name)
                        }
                    }
                }
                .listStyle(.plain)
            } else if let error = model.sideError {
                Text(error).font(.caption).foregroundStyle(.red)
            } else {
                ProgressView().controlSize(.small)
            }
        }
    }
}

private struct ChangeRow: View {
    let model: WorkspaceDetailModel
    let repo: WorkspaceRepoDetail
    let change: ChangedFile
    let name: String
    @State private var hovering = false

    var body: some View {
        let (letter, color) = changeLetter(change.status)
        HStack(spacing: 6) {
            Text(letter).font(.caption.monospaced().weight(.bold)).foregroundStyle(color)
            Text(name).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 4)
            if hovering {
                if change.status != "deleted" {
                    Button("✎") { model.openTab(.editor(repo: repo.id, path: change.path, worktree: model.sideWorktree)) }
                        .buttonStyle(.borderless).help("Edit this file")
                }
                CopyButton(text: change.path, help: "Copy the path")
            }
            if change.additions > 0 { Text("+\(change.additions)").font(.caption2).foregroundStyle(.green) }
            if change.deletions > 0 { Text("−\(change.deletions)").font(.caption2).foregroundStyle(.red) }
        }
        .contentShape(Rectangle())
        .onTapGesture { model.openTab(.diff(repo: repo.id, path: change.path, worktree: model.sideWorktree)) }
        .onHover { hovering = $0 }
        .help(change.path)
    }
}

private struct FilesView: View {
    let model: WorkspaceDetailModel
    let repo: WorkspaceRepoDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let files = model.sideKey.flatMap({ model.files[$0] }) {
                HStack {
                    Text("\(files.count) file\(files.count == 1 ? "" : "s")").font(.caption)
                    CopyButton(text: files.joined(separator: "\n"), help: "Copy every path")
                }
                if files.isEmpty { Text("No files.").font(.caption).foregroundStyle(.secondary) }
                List {
                    FileTree(nodes: buildFileTree(files), expandedByDefault: false) { node in
                        FileRow(model: model, repo: repo, node: node)
                    }
                }
                .listStyle(.plain)
            } else if let error = model.sideError {
                Text(error).font(.caption).foregroundStyle(.red)
            } else {
                ProgressView().controlSize(.small)
            }
        }
    }
}

private struct FileRow: View {
    let model: WorkspaceDetailModel
    let repo: WorkspaceRepoDetail
    let node: FileTreeNode
    @State private var hovering = false

    var body: some View {
        HStack {
            Label(node.name, systemImage: "doc").lineLimit(1)
            Spacer()
            if hovering { CopyButton(text: node.path, help: "Copy the path") }
        }
        .contentShape(Rectangle())
        .onTapGesture { model.openTab(.editor(repo: repo.id, path: node.path, worktree: model.sideWorktree)) }
        .onHover { hovering = $0 }
        .help(node.path)
    }
}

// MARK: - Comments

private struct CommentsView: View {
    let model: WorkspaceDetailModel
    @State private var feedback: String?

    var body: some View {
        let comments = model.comments
        let open = comments.filter { !$0.isResolved }.count
        let resolved = comments.count - open
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("\(open) open\(resolved > 0 ? " · \(resolved) resolved" : "")").font(.caption)
                Spacer()
                Button(feedback ?? "Copy for Claude") {
                    feedback = model.copyCommentsForClaude() ? "Copied" : "Copying failed"
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        feedback = nil
                    }
                }
                .controlSize(.small)
                .disabled(open == 0)
            }
            if let error = model.commentsError {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            if comments.isEmpty {
                Text("No comments yet. Open a changed file's diff and click the line numbers to leave one.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(comments) { comment in
                        ReviewCommentCard(model: model, comment: comment, showsLocation: true)
                    }
                }
            }
        }
    }
}

struct ReviewCommentCard: View {
    let model: WorkspaceDetailModel
    let comment: ReviewComment
    let showsLocation: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if showsLocation {
                    Button(formatCommentLocation(comment, repoName: model.repoNames)) {
                        model.openTab(.diff(repo: comment.workspaceRepoId, path: comment.path, worktree: nil))
                    }
                    .buttonStyle(.link)
                    .font(.caption.monospaced())
                    .lineLimit(1)
                }
                if let date = parseISODate(comment.createdAt) {
                    Text(date, style: .relative).font(.caption2).foregroundStyle(.secondary)
                }
                if comment.source == "verification" { Chip(text: "report finding", color: .cyan) }
                if comment.isResolved { Chip(text: "resolved") }
                Spacer()
                Button(comment.isResolved ? "Reopen" : "Resolve") { model.setResolved(comment, !comment.isResolved) }
                    .buttonStyle(.borderless).controlSize(.small)
                Button("×") { model.deleteComment(comment) }
                    .buttonStyle(.borderless).help("Delete this comment")
            }
            Text(comment.body)
                .font(.callout)
                .strikethrough(comment.isResolved)
                .foregroundStyle(comment.isResolved ? .secondary : .primary)
                .textSelection(.enabled)
            if let sha = comment.commitSha {
                Text("at \(sha.prefix(7))").font(.caption2.monospaced()).foregroundStyle(.secondary)
            }
        }
        .padding(8)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - PR checks

/// The primary worktree's PR, as the sidecar's poller last saw it.
private struct PrChecksView: View {
    let repo: WorkspaceRepoDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let pr = repo.pr, pr.lastPolledAt != nil {
                if let number = pr.prNumber {
                    HStack(spacing: 6) {
                        Text("#\(number)").font(.callout.monospaced())
                        Chip(text: pr.prState ?? "open", color: prStateColor(pr.prState))
                        if pr.isDraft == true { Chip(text: "draft") }
                        Spacer()
                        if let url = pr.prUrl {
                            Button("Open externally ↗") { openExternal(url) }.controlSize(.small)
                            CopyButton(text: url, help: "Copy the PR's link")
                        }
                    }
                    Text(checksLabel(pr.checkRollup)).foregroundStyle(checksColor(pr.checkRollup))
                    if let c = pr.checks {
                        Text("\(c.success) passing · \(c.failure) failing · \(c.pending) running")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let mergeable = pr.mergeable {
                        Text("mergeable: \(mergeable)").font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    Text("No PR for \(repo.branch) yet.").foregroundStyle(.secondary)
                }
                if let error = pr.lastError { Text(error).font(.caption).foregroundStyle(.red) }
            } else if repo.pr == nil, repo.prsPolledAt != nil {
                Text("No PR for \(repo.branch) yet.").foregroundStyle(.secondary)
                if let error = repo.prsPollError { Text(error).font(.caption).foregroundStyle(.red) }
            } else {
                Text("Not polled yet.").foregroundStyle(.secondary)
            }
        }
        .font(.callout)
    }
}
