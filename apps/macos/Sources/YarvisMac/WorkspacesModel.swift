import AppKit
import Foundation
import Observation
import YarvisClient

/// The Workspaces page: the workspace list and the selected workspace.
@MainActor @Observable
final class WorkspacesModel {
    private unowned let app: AppModel
    private let client: YarvisClient

    var workspaces: [WorkspaceSummary] = []
    var selectedId: String? = UserDefaults.standard.string(forKey: "workspaces.selectedId") {
        didSet {
            UserDefaults.standard.set(selectedId, forKey: "workspaces.selectedId")
            if selectedId != oldValue {
                newWorkspace = nil
                mountDetail()
            }
        }
    }
    /// The list's last load failure. A failed background poll doesn't set
    /// it; the last list stays on screen.
    var error: String?
    private(set) var refreshing = false
    var showArchived = UserDefaults.standard.bool(forKey: "workspaces.showArchived") {
        didSet { UserDefaults.standard.set(showArchived, forKey: "workspaces.showArchived") }
    }
    /// The open new-workspace form, shown in place of the selected workspace.
    var newWorkspace: NewWorkspaceModel?
    private(set) var detail: WorkspaceDetailModel?

    /// One terminal surface per workspace, kept while the app is signed in
    /// so switching workspaces keeps each one's scrollback.
    private var surfaces: [String: TerminalSurfaceModel] = [:]
    private var pollTask: Task<Void, Never>?
    /// Selected ids already checked against the server, so a missing one is
    /// looked up once rather than on every poll.
    private var verified: Set<String> = []
    private var loaded = false

    init(app: AppModel, client: YarvisClient) {
        self.app = app
        self.client = client
        mountDetail()
        resync()
        startPolling()
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        detail?.stop()
        detail = nil
        newWorkspace?.stop()
        surfaces.values.forEach { $0.stop() }
        surfaces = [:]
    }

    /// PTY starts and exits can be the selected workspace's agent, so its
    /// liveness is read again rather than waiting for the next probe.
    func handle(_ event: ServerEvent) {
        if event.kind == "pty.started" || event.kind == "pty.exited" { detail?.probeAgent() }
    }

    func resync() {
        Task { await refresh(background: false) }
        detail?.reload()
    }

    /// Selects a workspace, and brings `focusSessionKey` into view when given.
    func open(id: String, focusSessionKey: String?) {
        newWorkspace?.stop()
        newWorkspace = nil
        selectedId = id
        if let focusSessionKey { detail?.focus(sessionKey: focusSessionKey) }
    }

    // MARK: Visibility

    /// Polls are skipped while the page isn't on screen.
    var pageVisible: Bool { app.section == .workspaces && !NSApp.isHidden }
    /// The user is looking at the page right now, which asks the sidecar to
    /// keep PRs fresher.
    var userIsLooking: Bool { pageVisible && NSApp.isActive }

    /// The page came on screen: read the list now rather than at the next tick.
    func appeared() {
        Task { await refresh(background: true) }
        detail?.appeared()
    }

    // MARK: The list

    var attentionIds: Set<String> {
        Set(app.attention?.items.compactMap(\.workspaceId) ?? [])
    }

    var archivedCount: Int { workspaces.filter { $0.status == "archived" }.count }

    var shownGroups: [WorkspaceGroup] {
        groupWorkspaces(showArchived ? workspaces : workspaces.filter { $0.status != "archived" })
    }

    /// Reads the list. A background poll that fails keeps the last list and
    /// shows nothing; a load the user is waiting on shows the error.
    func refresh(background: Bool) async {
        refreshing = true
        defer { refreshing = false }
        do {
            workspaces = try await client.workspaceList(badges: userIsLooking)
            error = nil
            loaded = true
            await verifySelection()
        } catch {
            if !background || !loaded { self.error = error.localizedDescription }
        }
    }

    private func startPolling() {
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                // Faster while a teardown runs, so its rows settle promptly.
                let tearingDown = self?.workspaces.contains { $0.status == "archiving" && $0.error == nil } ?? false
                try? await Task.sleep(for: .seconds(tearingDown ? 2 : 20))
                guard let self, !Task.isCancelled else { return }
                if self.pageVisible { await self.refresh(background: true) }
            }
        }
    }

    /// A selected id missing from the list may be brand new (a workspace an
    /// issue's Start work just made) or gone. Ask once before dropping it.
    private func verifySelection() async {
        guard let id = selectedId, !workspaces.contains(where: { $0.id == id }), !verified.contains(id) else { return }
        verified.insert(id)
        do {
            _ = try await client.workspace(id: id, viewing: false)
            workspaces = try await client.workspaceList(badges: userIsLooking)
        } catch YarvisError.http(status: 404, _, _) {
            if selectedId == id { selectedId = nil }
        } catch {}
    }

    // MARK: Detail

    private func mountDetail() {
        detail?.stop()
        detail = selectedId.map { WorkspaceDetailModel(page: self, app: app, client: client, id: $0) }
    }

    /// The workspace's terminal surface, made on first use.
    func surface(workspaceId: String, rootPath: String) -> TerminalSurfaceModel {
        if let existing = surfaces[workspaceId] { return existing }
        let surface = TerminalSurfaceModel(app: app, client: client, storageKey: "ws:\(workspaceId)",
                                           cwd: rootPath, opensShellTab: false)
        surfaces[workspaceId] = surface
        return surface
    }

    // MARK: New workspace

    func startNewWorkspace(name: String? = nil, taskId: String? = nil, startWork: Bool? = nil) {
        newWorkspace?.stop()
        newWorkspace = NewWorkspaceModel(app: app, client: client, name: name ?? "", taskId: taskId,
                                         startWork: startWork) { [weak self] id in
            guard let self else { return }
            await self.refresh(background: true)
            self.newWorkspace = nil
            self.selectedId = id
        }
    }

    func cancelNewWorkspace() {
        newWorkspace?.stop()
        newWorkspace = nil
    }
}
