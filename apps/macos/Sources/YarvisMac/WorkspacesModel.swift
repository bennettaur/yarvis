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
                newWorkspace?.stop()
                newWorkspace = nil
                mountDetail()
            }
        }
    }
    /// The list's last load failure. A failed background poll doesn't set
    /// it; the last list stays on screen.
    var error: String?
    var refreshing: Bool { listLoadsInFlight > 0 }
    private var listLoadsInFlight = 0
    /// Bumped per list read, so an older answer that lands last is dropped.
    private var listGeneration = 0
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
    private var activationTask: Task<Void, Never>?
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
        watchActivation()
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        activationTask?.cancel()
        activationTask = nil
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

    /// Polls run only while the user can see the page: the app is in front,
    /// its window isn't covered, and the Workspaces page is the one showing.
    var pageVisible: Bool {
        guard app.section == .workspaces, NSApp.isActive,
              let window = NSApp.mainWindow ?? NSApp.keyWindow else { return false }
        return window.occlusionState.contains(.visible)
    }

    /// Sent as `badges=1` and `viewing=1`, which ask the sidecar to keep PRs
    /// fresher while the user is looking.
    var userIsLooking: Bool { pageVisible }

    /// Polls skip ticks while the app is in the background, so coming back
    /// reads at once rather than up to a poll interval later.
    private func watchActivation() {
        activationTask = Task { [weak self] in
            for await _ in NotificationCenter.default.notifications(named: NSApplication.didBecomeActiveNotification) {
                guard let self else { return }
                if self.app.section == .workspaces { self.appeared() }
            }
        }
    }

    /// The page came on screen: read the list now rather than at the next tick.
    func appeared() {
        Task { await refresh(background: true) }
        detail?.appeared()
    }

    // MARK: The list

    var attentionIds: Set<String> {
        Set(app.attention?.items.compactMap(\.workspaceId) ?? [])
    }

    var archivedCount: Int { workspaces.filter(\.isArchived).count }

    var shownGroups: [WorkspaceGroup] {
        groupWorkspaces(showArchived ? workspaces : workspaces.filter { !$0.isArchived })
    }

    /// Reads the list. A background poll that fails keeps the last list and
    /// shows nothing; a load the user is waiting on shows the error.
    func refresh(background: Bool) async {
        listGeneration += 1
        let generation = listGeneration
        listLoadsInFlight += 1
        defer { listLoadsInFlight -= 1 }
        do {
            let fresh = try await client.workspaceList(badges: userIsLooking)
            guard generation == listGeneration else { return }
            apply(fresh)
            error = nil
            loaded = true
            await verifySelection()
        } catch {
            guard generation == listGeneration else { return }
            if !background || !loaded { self.error = error.localizedDescription }
        }
    }

    private func apply(_ fresh: [WorkspaceSummary]) {
        if fresh != workspaces { workspaces = fresh }
        dropUnusedSurfaces()
    }

    /// A workspace that is archived, or gone from the list, has no terminals
    /// left to show, so its surface and sockets go. The selected one is kept
    /// while it may just not be listed yet.
    private func dropUnusedSurfaces() {
        let live = Set(workspaces.filter { !$0.isArchived }.map(\.id))
        let listed = Set(workspaces.map(\.id))
        for id in surfaces.keys where !live.contains(id) && (listed.contains(id) || id != selectedId) {
            surfaces.removeValue(forKey: id)?.stop()
        }
    }

    private func startPolling() {
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                // Faster while a teardown runs, so its rows settle promptly.
                let tearingDown = self?.workspaces.contains(where: \.isTearingDown) ?? false
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
            listGeneration += 1
            let generation = listGeneration
            let fresh = try await client.workspaceList(badges: userIsLooking)
            if generation == listGeneration { apply(fresh) }
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
