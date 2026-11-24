import SwiftUI
import YarvisClient

/// The workspace's left nav: stack layers to add, then per PR its sections,
/// changed files, commits and every file.
struct ReviewNavView: View {
    @Bindable var model: ReviewWorkspaceModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if model.prs.isEmpty {
                    Text("Paste a PR link above to start reviewing.").font(.callout).foregroundStyle(.secondary)
                }
                ForEach(model.stackPickers(), id: \.entries.first?.ref.key) { stack in
                    ReviewStackPicker(model: model, stack: stack)
                }
                ForEach(model.orderedPrs, id: \.prId) { pr in
                    ReviewNavPrGroup(model: model, pr: pr)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct ReviewStackPicker: View {
    @Bindable var model: ReviewWorkspaceModel
    let stack: PrStack

    var body: some View {
        let layers = addableLayers(stack, held: model.heldRefKeys)
        if !layers.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text("Stack · \(layers.count) not added").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                ForEach(layers, id: \.ref.key) { entry in
                    Toggle(isOn: Binding(get: { model.isPicked(entry) }, set: { model.stackPicks[entry.ref.key] = $0 })) {
                        HStack(spacing: 4) {
                            Text("#\(entry.number) \(entry.title)").lineLimit(1)
                            if entry.reviewDecision == "approved" { Chip(text: "Approved", color: .green) }
                            if entry.draft { Chip(text: "Draft") }
                        }
                        .font(.caption)
                    }
                    .toggleStyle(.checkbox)
                }
                let picked = layers.filter(model.isPicked)
                HStack {
                    Button("Add selected (\(picked.count))") { model.addLayers(picked.map(\.ref)) }
                        .disabled(picked.isEmpty || model.addingLayers)
                    Button("Add all") { model.addLayers(layers.map(\.ref)) }
                        .disabled(model.addingLayers)
                }
                .controlSize(.small)
            }
            .padding(8)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
        }
    }
}

private struct ReviewNavPrGroup: View {
    @Bindable var model: ReviewWorkspaceModel
    let pr: ReviewPrModel
    @State private var expanded = true
    @State private var filesOpen = true
    @State private var commitsOpen: Bool?
    @State private var allOpen = false

    private var color: Color { reviewPrColor(pr.pr.colorIndex) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 6) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.caption2)
                    Circle().fill(color).frame(width: 8, height: 8)
                    Text(prLabel(pr.ref)).font(.caption.monospaced())
                    Text(pr.pr.title).font(.callout.weight(.medium)).lineLimit(2)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if let status = cloneStatusText(pr.pr, lastLog: model.cloneLogs[pr.prId]) {
                let failed = pr.pr.status == "error" || pr.pr.worktreeStatus == "error"
                Text(status)
                    .font(.caption)
                    .foregroundStyle(failed ? .red : .secondary)
                    .lineLimit(2)
                    .phaseAnimator(failed ? [1.0] : [1.0, 0.5]) { $0.opacity($1) }
            }
            if expanded { content }
        }
        .padding(.leading, 6)
        .overlay(alignment: .leading) { Rectangle().fill(color).frame(width: 2) }
        .onAppear(perform: load)
        .onChange(of: pr.pr.headSha) { _, _ in load() }
        // The commits it marks as new are counted from the last review.
        .onChange(of: pr.lastReview.value) { _, _ in pr.loadCommits(force: true) }
    }

    private func load() {
        pr.loadDetail()
        pr.loadChangedFiles()
        pr.loadLastReview()
        pr.loadCommits()
        pr.loadChecklist()
        if pr.viewed == nil { pr.loadViewed() }
    }

    @ViewBuilder
    private var content: some View {
        let active = model.layout.activeTab
        let detail = pr.detail.value
        let openThreads = (detail?.reviewThreads ?? []).filter { !$0.isResolved }.count
        let newCommits = (pr.commits.value?.commits ?? []).filter(\.isNew).count
        ForEach(Self.items, id: \.self) { kind in
            let badge: String? = kind == .comments && openThreads > 0 ? "\(openThreads)"
                : kind == .sinceReview && newCommits > 0 ? "\(newCommits) new" : nil
            Button { model.openTab(ReviewTabSpec(kind: kind, prId: pr.prId)) } label: {
                HStack {
                    Text(kind.label)
                    Spacer()
                    if let badge { Text(badge).font(.caption2).foregroundStyle(.secondary) }
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(active?.prId == pr.prId && active?.kind == kind ? Color.accentColor.opacity(0.2) : .clear,
                            in: RoundedRectangle(cornerRadius: 4))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .font(.callout)
        }
        if needsSetupAnswer(pr.pr) {
            Button("Setup hasn't run · review the script…") { model.openSetup(prId: pr.prId) }
                .buttonStyle(.plain)
                .font(.caption)
                .foregroundStyle(.orange)
        }
        DisclosureGroup(isExpanded: $filesOpen) {
            ReviewChangedFilesTree(model: model, pr: pr)
        } label: {
            sectionLabel("Changed files", count: pr.changedFiles.value?.files.count)
        }
        DisclosureGroup(isExpanded: Binding(get: { commitsOpen ?? (newCommits > 0) }, set: { commitsOpen = $0 })) {
            ReviewCommitsList(model: model, pr: pr)
        } label: {
            sectionLabel("Commits", count: pr.commits.value?.commits.count)
        }
        DisclosureGroup(isExpanded: $allOpen) {
            ReviewAllFilesTree(model: model, pr: pr)
        } label: {
            sectionLabel("All files", count: nil)
        }
    }

    private func sectionLabel(_ title: String, count: Int?) -> some View {
        HStack {
            Text(title).font(.caption.weight(.medium))
            if let count { Text("\(count)").font(.caption2).foregroundStyle(.secondary) }
        }
    }

    private static let items: [ReviewTabSpec.Kind] = [
        .description, .reviewers, .checks, .comments, .sinceReview, .verification, .diagram,
    ]
}

func fileStatusColor(_ status: String) -> Color {
    switch status {
    case "added": return .green
    case "deleted": return .red
    case "renamed": return .cyan
    default: return .orange
    }
}

private struct ReviewChangedFilesTree: View {
    @Bindable var model: ReviewWorkspaceModel
    let pr: ReviewPrModel

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if pr.detail.value == nil && pr.detail.loading && pr.changedFiles.value == nil {
                Text("Fetching the pull request…").font(.caption).foregroundStyle(.secondary)
            }
            if let error = pr.changedFiles.error, pr.changedFiles.value == nil {
                Text(error).font(.caption).foregroundStyle(.red)
            } else if let files = pr.changedFiles.value?.files {
                if files.isEmpty {
                    Text("No file changes.").font(.caption).foregroundStyle(.secondary)
                } else {
                    summary(files)
                    let byPath = Dictionary(files.map { ($0.path, $0) }, uniquingKeysWith: { a, _ in a })
                    ForEach(buildFileTree(files.map(\.path))) { node in
                        ReviewFileTreeRows(node: node, depth: 0) { path in
                            byPath[path].map { ReviewChangedFileRow(model: model, pr: pr, file: $0) }
                        }
                    }
                }
            } else if pr.pr.headSha != nil {
                Text("Loading files…").font(.caption).foregroundStyle(.secondary)
            }
            if let error = pr.viewedError { Text(error).font(.caption).foregroundStyle(.red) }
        }
    }

    @ViewBuilder
    private func summary(_ files: [ReviewChangedFile]) -> some View {
        let viewed = pr.viewed.map { v in files.filter { v.contains($0.path) }.count }
        let mustRead = pr.checklist.value?.report?.mustRead?.count ?? 0
        HStack(spacing: 8) {
            if let viewed { Text("\(viewed)/\(files.count) viewed") }
            if mustRead > 0 { Text("★ \(mustRead) must read").foregroundStyle(.orange) }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
}

/// A folder tree whose folders start open; `file` draws each file row.
private struct ReviewFileTreeRows<Row: View>: View {
    let node: FileTreeNode
    let depth: Int
    var startsOpen = true
    @ViewBuilder let file: (String) -> Row?
    @State private var open: Bool?

    var body: some View {
        if let children = node.children {
            VStack(alignment: .leading, spacing: 1) {
                Button { open = !(open ?? startsOpen) } label: {
                    HStack(spacing: 4) {
                        Image(systemName: (open ?? startsOpen) ? "chevron.down" : "chevron.right").font(.caption2)
                        Text(node.name).font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.leading, CGFloat(depth) * 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                // Built only once opened: a whole repository is far more rows than to build up front.
                if open ?? startsOpen {
                    ForEach(children) { child in
                        ReviewFileTreeRows(node: child, depth: depth + 1, startsOpen: startsOpen, file: file)
                    }
                }
            }
        } else {
            file(node.path).padding(.leading, CGFloat(depth) * 10)
        }
    }
}

private struct ReviewChangedFileRow: View {
    @Bindable var model: ReviewWorkspaceModel
    let pr: ReviewPrModel
    let file: ReviewChangedFile

    var body: some View {
        let viewed = pr.viewed?.contains(file.path)
        let mustRead = pr.checklist.value?.report?.mustRead?.first { $0.path == file.path }
        let threads = pr.detail.value?.reviewThreads ?? []
        let count = navCommentCounts(threads)[file.path] ?? 0
        let active = model.layout.activeTab
        HStack(spacing: 4) {
            Toggle("", isOn: Binding(get: { viewed ?? false }, set: { pr.setViewed(file.path, $0) }))
                .toggleStyle(.checkbox)
                .labelsHidden()
                .disabled(viewed == nil)
                .help("Viewed")
            Text(fileStatusLetter(file.status))
                .font(.caption2.monospaced().weight(.bold))
                .foregroundStyle(fileStatusColor(file.status))
            Button { model.openTab(.diff(prId: pr.prId, path: file.path)) } label: {
                Text(file.path.split(separator: "/").last.map(String.init) ?? file.path)
                    .font(.caption)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(file.oldPath.map { "\($0) → \(file.path)" } ?? file.path)
            if let mustRead {
                Text("★").font(.caption).foregroundStyle(.orange).help("Must read: \(mustRead.reason)")
            }
            if count > 0 {
                let open = navOpenThreadPaths(threads).contains(file.path)
                Label("\(count)", systemImage: "text.bubble")
                    .font(.caption2)
                    .foregroundStyle(open ? .orange : .secondary)
                    .help(open ? "Has open comments" : "Comments")
            }
        }
        .opacity(viewed == true ? 0.55 : 1)
        .padding(.horizontal, 2)
        .background(active?.kind == .diff && active?.prId == pr.prId && active?.path == file.path
            ? Color.accentColor.opacity(0.2) : .clear, in: RoundedRectangle(cornerRadius: 3))
    }
}

private struct ReviewCommitsList: View {
    @Bindable var model: ReviewWorkspaceModel
    let pr: ReviewPrModel

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let error = pr.commits.error, pr.commits.value == nil {
                Text(error).font(.caption).foregroundStyle(.red)
            } else if let commits = pr.commits.value {
                if commits.commits.isEmpty { Text("No commits.").font(.caption).foregroundStyle(.secondary) }
                ForEach(commits.commits, id: \.sha) { commit in
                    Button { model.openTab(.commit(prId: pr.prId, sha: commit.sha, subject: commit.subject)) } label: {
                        HStack(spacing: 6) {
                            Text(commit.sha.prefix(7)).font(.caption.monospaced()).foregroundStyle(.secondary)
                            Text(commit.subject).font(.caption).lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 3)
                        .background(commit.isNew ? Color.blue.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: 3))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("\(commit.sha)\n\(commit.subject)\n\(commit.author) · \(commit.date)"
                        + (commit.isNew ? "\nNew since your last review" : ""))
                }
                if commits.truncated { Text("Older commits not shown.").font(.caption2).foregroundStyle(.secondary) }
            } else if pr.pr.headSha != nil {
                ProgressView().controlSize(.mini)
            }
        }
    }
}

private struct ReviewAllFilesTree: View {
    @Bindable var model: ReviewWorkspaceModel
    let pr: ReviewPrModel
    @State private var query = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let error = pr.tree.error, pr.tree.value == nil {
                Text(error).font(.caption).foregroundStyle(.red)
            } else if let paths = pr.tree.value?.paths {
                let changed = Set(pr.changedFiles.value?.files.map(\.path) ?? [])
                TextField("Filter \(paths.count) files…", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.small)
                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    ForEach(buildFileTree(paths)) { node in
                        ReviewFileTreeRows(node: node, depth: 0, startsOpen: false) { path in
                            row(path, label: path.split(separator: "/").last.map(String.init) ?? path,
                                changed: changed.contains(path))
                        }
                    }
                } else {
                    let matches = filterPaths(paths, query: query)
                    if matches.isEmpty { Text("No matches.").font(.caption).foregroundStyle(.secondary) }
                    ForEach(matches, id: \.self) { path in row(path, label: path, changed: changed.contains(path)) }
                    if matches.count >= 200 {
                        Text("First 200 shown; keep typing to narrow.").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            } else if pr.pr.headSha != nil {
                ProgressView().controlSize(.mini)
            }
        }
        .onAppear { pr.loadTree() }
    }

    private func row(_ path: String, label: String, changed: Bool) -> some View {
        Button {
            model.openTab(changed ? .diff(prId: pr.prId, path: path) : .file(prId: pr.prId, path: path))
        } label: {
            HStack(spacing: 4) {
                Text(label).font(.caption.monospaced()).lineLimit(1)
                if changed { Text("changed").font(.caption2).foregroundStyle(.orange) }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(path)
    }
}
