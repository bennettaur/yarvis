import SwiftUI
import YarvisClient

/// One of the PR's commits on its own: the files it touched, and the diff of
/// the one picked against the commit's first parent. A merge commit
/// therefore shows what the merge brought in from the base.
struct ReviewCommitTab: View {
    let context: ReviewTabContext
    let spec: ReviewTabSpec

    @State private var files: CommitFiles?
    @State private var loadError: String?
    @State private var picked: String?

    private var sha: String { spec.sha ?? "" }

    var body: some View {
        let pr = context.pr
        Group {
            if let files {
                loaded(files)
            } else if let loadError {
                ReviewCodeNote(text: loadError, error: true)
            } else {
                ReviewCodeNote(text: "Loading commit…", loading: true)
            }
        }
        .onAppear { pr.loadCommits() }
        .task(id: sha) { await load() }
    }

    @ViewBuilder
    private func loaded(_ files: CommitFiles) -> some View {
        let list = files.files
        let current = list.first { $0.path == picked } ?? list.first
        // A force-push can drop the commit from the PR; it still reads (the
        // clone has it), so the tab says so rather than closing.
        let listed = context.pr.commits.value
        let gone = listed.map { !$0.truncated && !$0.commits.contains { $0.sha == sha } } ?? false
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(String(sha.prefix(7))).font(.callout.monospaced()).foregroundStyle(.secondary)
                Text(spec.subject ?? "").lineLimit(1)
                if gone {
                    Text("No longer in this pull request")
                        .font(.caption)
                        .padding(.horizontal, 6)
                        .background(Color.orange.opacity(0.2), in: RoundedRectangle(cornerRadius: 4))
                }
                Spacer()
                Text("\(list.count) \(list.count == 1 ? "file" : "files")").font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            Divider()
            HStack(spacing: 0) {
                List(list, id: \.path, selection: Binding(get: { current?.path }, set: { picked = $0 })) { file in
                    let status = reviewFileStatus(file.status)
                    HStack(spacing: 6) {
                        Text(status.mark).font(.caption.monospaced()).foregroundStyle(status.color).frame(width: 12)
                        Text(file.path).font(.caption.monospaced()).lineLimit(1).truncationMode(.head)
                    }
                    .help(file.path)
                }
                .listStyle(.sidebar)
                .frame(width: 224)
                .accessibilityLabel("Files in this commit")
                Divider()
                if let current {
                    ReviewCommitFileDiff(context: context, sha: sha, file: current).id(current.path)
                } else {
                    ReviewCodeNote(text: "This commit changes no files.")
                }
            }
        }
    }

    private func load() async {
        let pr = context.pr
        let (client, ws, id, sha) = (context.client, pr.workspaceId, pr.prId, sha)
        do {
            files = try await ReviewCodeCache.shared.value("commit:\(id):\(sha)") {
                try await client.commitFiles(workspaceId: ws, prId: id, sha: sha)
            }
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}

private struct ReviewCommitFileDiff: View {
    let context: ReviewTabContext
    let sha: String
    let file: ReviewChangedFile

    @State private var diff: CommitFileDiff?
    @State private var document: ReviewCodeDocument?
    @State private var loadError: String?

    var body: some View {
        Group {
            if file.binary {
                ReviewCodeNote(text: "Binary file — no text diff to show.")
            } else if let diff, diff.tooLarge {
                ReviewCodeNote(text: "This file is too large to show here.")
            } else if let document {
                ReviewCodeView(document: document, folded: true)
            } else if let loadError {
                ReviewCodeNote(text: loadError, error: true)
            } else {
                ReviewCodeNote(text: "Loading diff…", loading: true)
            }
        }
        .task(id: "\(sha):\(file.path):\(context.diffMode.rawValue)") { await load() }
    }

    private func load() async {
        guard !file.binary else { return }
        let pr = context.pr
        let (client, ws, id, sha, path) = (context.client, pr.workspaceId, pr.prId, sha, file.path)
        let key = "commit:\(id):\(sha):\(path)"
        do {
            let data: CommitFileDiff = try await ReviewCodeCache.shared.value(key) {
                try await client.commitFileDiff(workspaceId: ws, prId: id, sha: sha, path: path)
            }
            diff = data
            loadError = nil
            guard !data.tooLarge else { return }
            let old = data.original?.content ?? ""
            let new = data.modified?.content ?? ""
            let split = context.diffMode == .split
            document = await ReviewCodeCache.shared.document("\(key)|\(split)") {
                .diff(oldKey: "commit:\(id):\(data.parentSha):\(data.oldPath ?? path)", old: old,
                      newKey: "commit:\(id):\(sha):\(path)", new: new, path: path, split: split)
            }
        } catch {
            loadError = error.localizedDescription
        }
    }
}
