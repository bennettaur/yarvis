import Foundation
import Observation
import YarvisClient

/// An editor tab for one file. Keyed by file, so a save can never write one
/// file's text over another with a fresh hash. The save and conflict rules
/// are `EditorBuffer`'s.
@MainActor @Observable
final class WorkspaceEditorModel {
    let workspaceRepoId: String
    let path: String
    let worktree: String?
    private let workspaceId: String
    private let client: YarvisClient
    private unowned let app: AppModel

    var buffer = EditorBuffer()
    private(set) var saving = false
    private var tasks: [Task<Void, Never>] = []

    init(app: AppModel, client: YarvisClient, workspaceId: String, workspaceRepoId: String, path: String,
         worktree: String?) {
        self.app = app
        self.client = client
        self.workspaceId = workspaceId
        self.workspaceRepoId = workspaceRepoId
        self.path = path
        self.worktree = worktree
        run { await self.read(keepText: false) }
    }

    func stop() {
        tasks.forEach { $0.cancel() }
        tasks = []
    }

    private func run(_ body: @escaping @MainActor () async -> Void) {
        tasks.append(Task { await body() })
    }

    var dirty: Bool { buffer.dirty }

    var unreadableMessage: String? {
        switch buffer.unreadable {
        case "binary": return "This is a binary file."
        case "too-large": return "This file is too large to open in the editor."
        case "encoding": return "This file is not valid UTF-8, so editing it would rewrite the bytes we cannot read."
        case nil: return nil
        case let other?: return "This file can't be edited (\(other))."
        }
    }

    private func read(keepText: Bool) async {
        let result: Result<WorkspaceFile, Error>
        do {
            result = .success(try await client.readWorkspaceFile(id: workspaceId, repo: workspaceRepoId, path: path,
                                                                 worktree: worktree))
        } catch {
            result = .failure(error)
        }
        if !Task.isCancelled { buffer.read(result, keepText: keepText) }
    }

    /// Drops the edits and reads the file from disk.
    func revert() {
        run { await self.read(keepText: false) }
    }

    func save() {
        guard !saving, let pending = buffer.pendingSave else { return }
        saving = true
        let (client, workspaceId, workspaceRepoId, path, worktree) = (client, workspaceId, workspaceRepoId, path, worktree)
        run {
            defer { self.saving = false }
            let result: Result<String?, Error>
            do {
                result = .success(try await self.app.withFreshCode {
                    try await client.saveWorkspaceFile(id: workspaceId, repo: workspaceRepoId, path: path,
                                                       content: pending.content, expectedHash: pending.expectedHash,
                                                       worktree: worktree)
                })
            } catch {
                result = .failure(error)
            }
            if !Task.isCancelled { self.buffer.saved(result, content: pending.content) }
        }
    }

    /// Saves over a change made on disk since the file was opened: reads the
    /// file's fresh hash, keeping the edits, then saves.
    func overwrite() {
        run {
            await self.read(keepText: true)
            guard !Task.isCancelled, self.buffer.error == nil else { return }
            self.save()
        }
    }
}
