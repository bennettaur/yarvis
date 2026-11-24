import Foundation
import Observation
import YarvisClient

/// The new-workspace form, then the provision log once it is created.
@MainActor @Observable
final class NewWorkspaceModel {
    enum Branches: Equatable {
        case loading
        case loaded([String])
        case failed(String)
    }

    private unowned let app: AppModel
    private let client: YarvisClient
    private let onCreated: @MainActor (String) async -> Void
    /// From another page's "Start work": the sidecar writes the brief and
    /// starts the agent itself.
    let startWork: Bool?

    var name: String
    var taskId: String?
    private(set) var repos: [Repo] = []
    private(set) var reposError: String?
    private(set) var tasks: [WorkspaceTask] = []
    var ticked: Set<String> = []
    private(set) var branches: [String: Branches] = [:]
    /// The existing branch picked per repo id; empty or absent is a new branch.
    var chosenBranch: [String: String] = [:]
    var error: String?
    private(set) var busy = false

    /// Set once the workspace exists and its provision log is showing.
    private(set) var provisioningName: String?
    private(set) var log = ""
    private var stream: Task<Void, Never>?

    init(app: AppModel, client: YarvisClient, name: String, taskId: String?, startWork: Bool?,
         onCreated: @escaping @MainActor (String) async -> Void) {
        self.app = app
        self.client = client
        self.name = name
        self.taskId = taskId
        self.startWork = startWork
        self.onCreated = onCreated
        Task { await load() }
    }

    func stop() {
        stream?.cancel()
    }

    private func load() async {
        do {
            repos = try await client.repos()
        } catch {
            reposError = error.localizedDescription
        }
        tasks = (try? await client.openTasks()) ?? []
    }

    func toggle(_ repo: Repo) {
        if ticked.contains(repo.id) {
            ticked.remove(repo.id)
        } else {
            ticked.insert(repo.id)
            switch branches[repo.id] {
            case nil, .failed?: loadBranches(repo.id)
            case .loading?, .loaded?: break
            }
        }
    }

    func loadBranches(_ repoId: String) {
        branches[repoId] = .loading
        Task {
            do {
                branches[repoId] = .loaded(try await client.repoBranches(repoId: repoId))
            } catch {
                branches[repoId] = .failed(error.localizedDescription)
            }
        }
    }

    func create() {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            error = "Pick a name."
            return
        }
        // In the list's order, so the workspace's repos read as the form did.
        let repoIds = repos.map(\.id).filter { ticked.contains($0) }
        let new = NewWorkspace(name: trimmed, repoIds: repoIds,
                               existingBranches: chosenBranch.filter { ticked.contains($0.key) },
                               taskId: taskId, startWork: startWork)
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let created = try await app.withFreshCode { [client] in try await client.createWorkspace(new) }
                provision(created)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// Follows the provision. A failure of the whole run stays on the log;
    /// anything else opens the workspace, which shows a failed repo's log.
    private func provision(_ ws: WorkspaceSummary) {
        provisioningName = ws.name
        log = ""
        stream = Task {
            var failure: String?
            do {
                for try await event in try client.provisionStream(id: ws.id) {
                    if let text = provisionLogText(event) { log += text }
                    if case .error(let message) = event { failure = message }
                }
            } catch is CancellationError {
                return
            } catch {
                failure = error.localizedDescription
            }
            if let failure {
                self.error = failure
            } else {
                await onCreated(ws.id)
            }
        }
    }
}
