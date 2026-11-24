import SwiftUI
import YarvisClient

/// The workspace's left nav: stack layers to add, then per PR its sections,
/// changed files, commits and every file.
struct ReviewNavView: View {
    @Bindable var model: ReviewWorkspaceModel

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
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
            if let status = cloneStatusText(pr.pr, lastLog: pr.cloneLog) {
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
        let activeKind = active?.prId == pr.prId ? active?.kind : nil
        let openThreads = pr.openThreadCount
        let newCommits = pr.newCommitCount
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
                .background(activeKind == kind ? Color.accentColor.opacity(0.2) : .clear,
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
            ReviewChangedFilesTree(model: model, pr: pr,
                                   activePath: activeKind == .diff ? active?.path : nil)
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

private struct ReviewChangedFilesTree: View {
    @Bindable var model: ReviewWorkspaceModel
    let pr: ReviewPrModel
    let activePath: String?
    @State private var toggled: Set<String> = []

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 1) {
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
                    let viewed = pr.viewed
                    ForEach(visibleTreeRows(pr.fileTree, startsOpen: true, toggled: toggled)) { row in
                        if row.node.isFolder {
                            ReviewFolderRow(name: row.node.name, depth: row.depth, open: !toggled.contains(row.id)) {
                                toggled.formSymmetricDifference([row.id])
                            }
                        } else if let file = pr.changedByPath[row.id] {
                            let prId = pr.prId
                            ReviewChangedFileRow(
                                file: file, depth: row.depth, viewed: viewed?.contains(file.path),
                                mustReadReason: pr.mustReadByPath[file.path]?.reason,
                                comments: pr.commentCounts[file.path] ?? 0,
                                hasOpenThreads: pr.openThreadPaths.contains(file.path),
                                active: activePath == file.path,
                                setViewed: { [pr] in pr.setViewed(file.path, $0) },
                                open: { [model] in model.openTab(.diff(prId: prId, path: file.path)) }
                            )
                            .equatable()
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
        let mustRead = pr.mustReadByPath.count
        HStack(spacing: 8) {
            if let viewed { Text("\(viewed)/\(files.count) viewed") }
            if mustRead > 0 { Text("★ \(mustRead) must read").foregroundStyle(.orange) }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
}

private struct ReviewFolderRow: View {
    let name: String
    let depth: Int
    let open: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 4) {
                Image(systemName: open ? "chevron.down" : "chevron.right").font(.caption2)
                Text(name).font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .padding(.leading, CGFloat(depth) * 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Takes plain values rather than reading the models, so a change to one
/// file's state redraws that row and not the whole tree.
private struct ReviewChangedFileRow: View, Equatable {
    let file: ReviewChangedFile
    let depth: Int
    let viewed: Bool?
    let mustReadReason: String?
    let comments: Int
    let hasOpenThreads: Bool
    let active: Bool
    let setViewed: (Bool) -> Void
    let open: () -> Void

    nonisolated static func == (a: Self, b: Self) -> Bool {
        a.file == b.file && a.depth == b.depth && a.viewed == b.viewed && a.mustReadReason == b.mustReadReason
            && a.comments == b.comments && a.hasOpenThreads == b.hasOpenThreads && a.active == b.active
    }

    var body: some View {
        let (letter, color) = changeLetter(file.status)
        HStack(spacing: 4) {
            Toggle("", isOn: Binding(get: { viewed ?? false }, set: { setViewed($0) }))
                .toggleStyle(.checkbox)
                .labelsHidden()
                .disabled(viewed == nil)
                .help("Viewed")
            Text(letter)
                .font(.caption2.monospaced().weight(.bold))
                .foregroundStyle(color)
            Button(action: open) {
                Text(file.path.split(separator: "/").last.map(String.init) ?? file.path)
                    .font(.caption)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(file.oldPath.map { "\($0) → \(file.path)" } ?? file.path)
            if let mustReadReason {
                Text("★").font(.caption).foregroundStyle(.orange).help("Must read: \(mustReadReason)")
            }
            if comments > 0 {
                Label("\(comments)", systemImage: "text.bubble")
                    .font(.caption2)
                    .foregroundStyle(hasOpenThreads ? .orange : .secondary)
                    .help(hasOpenThreads ? "Has open comments" : "Comments")
            }
        }
        .opacity(viewed == true ? 0.55 : 1)
        .padding(.horizontal, 2)
        .padding(.leading, CGFloat(depth) * 10)
        .background(active ? Color.accentColor.opacity(0.2) : .clear, in: RoundedRectangle(cornerRadius: 3))
    }
}

private struct ReviewCommitsList: View {
    @Bindable var model: ReviewWorkspaceModel
    let pr: ReviewPrModel

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 1) {
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
    /// Folders start closed: a whole repository is far more rows than to build up front.
    @State private var toggled: Set<String> = []

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 2) {
            if let error = pr.tree.error, pr.tree.value == nil {
                Text(error).font(.caption).foregroundStyle(.red)
            } else if let paths = pr.tree.value?.paths {
                TextField("Filter \(paths.count) files…", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.small)
                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    ForEach(visibleTreeRows(pr.allFilesTree, startsOpen: false, toggled: toggled)) { row in
                        if row.node.isFolder {
                            ReviewFolderRow(name: row.node.name, depth: row.depth, open: toggled.contains(row.id)) {
                                toggled.formSymmetricDifference([row.id])
                            }
                        } else {
                            fileRow(row.id, label: row.node.name).padding(.leading, CGFloat(row.depth) * 10)
                        }
                    }
                } else {
                    let matches = filterPaths(paths, query: query)
                    if matches.isEmpty { Text("No matches.").font(.caption).foregroundStyle(.secondary) }
                    ForEach(matches, id: \.self) { path in fileRow(path, label: path) }
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

    private func fileRow(_ path: String, label: String) -> some View {
        let changed = pr.changedByPath[path] != nil
        return Button {
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
