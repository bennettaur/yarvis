import Foundation
import Observation
import YarvisClient

/// A diff tab: the file's patch, read on open and on Refresh, with the
/// review comments drawn under their lines.
@MainActor @Observable
final class WorkspaceDiffModel {
    let workspaceRepoId: String
    let path: String
    /// Another worktree's path. Its diff is read-only: comments are filed by
    /// repo and path, so one left here would show on the workspace's own copy.
    let worktree: String?
    private let workspaceId: String
    private let client: YarvisClient
    private unowned let detail: WorkspaceDetailModel

    private(set) var lines: [DiffLine] = []
    private(set) var loaded = false
    private(set) var error: String?
    /// The selected range of new-file lines, while composing a comment.
    var selection: ClosedRange<Int>?
    var draft = ""
    var composeError: String?
    private(set) var saving = false
    private var tasks: [Task<Void, Never>] = []

    init(detail: WorkspaceDetailModel, client: YarvisClient, workspaceId: String, workspaceRepoId: String,
         path: String, worktree: String?) {
        self.detail = detail
        self.client = client
        self.workspaceId = workspaceId
        self.workspaceRepoId = workspaceRepoId
        self.path = path
        self.worktree = worktree
        refresh()
    }

    func stop() {
        tasks.forEach { $0.cancel() }
        tasks = []
    }

    var commentable: Bool { worktree == nil }

    var comments: [ReviewComment] { commentable ? detail.comments(repo: workspaceRepoId, path: path) : [] }

    func refresh() {
        tasks.append(Task {
            do {
                let diff = try await client.workspaceDiff(id: workspaceId, repo: workspaceRepoId, path: path,
                                                          worktree: worktree)
                guard !Task.isCancelled else { return }
                lines = parseUnifiedDiff(diff.patch)
                error = nil
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
            loaded = true
        })
    }

    /// A click on a line's number starts a range there; a shift-click
    /// stretches the range to it.
    func select(line: Int, extend: Bool) {
        guard commentable else { return }
        if extend, let current = selection {
            selection = min(current.lowerBound, line)...max(current.upperBound, line)
        } else {
            selection = line...line
        }
        composeError = nil
    }

    func cancelComment() {
        selection = nil
        draft = ""
        composeError = nil
    }

    func saveComment() {
        guard let range = selection, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        saving = true
        tasks.append(Task {
            defer { saving = false }
            if let failure = await detail.addComment(repo: workspaceRepoId, path: path, startLine: range.lowerBound,
                                                     endLine: range.upperBound, body: draft) {
                composeError = failure
            } else {
                cancelComment()
            }
        })
    }
}
