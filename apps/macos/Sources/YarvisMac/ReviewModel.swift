import AppKit
import Foundation
import Observation
import YarvisClient

/// The Review page: the list of review workspaces, or the one being reviewed.
/// The open workspace is remembered per server, so coming back lands where
/// the review was left rather than on the list.
@MainActor @Observable
final class ReviewModel {
    unowned let app: AppModel
    let client: YarvisClient

    var workspaces: [ReviewWorkspace] = []
    var archived: [ReviewWorkspace] = []
    var showArchived = false {
        didSet { if showArchived { Task { await refreshList() } } }
    }
    /// The list's last load failure.
    var error: String?
    /// Registered repos, for resolving a bare `repo#12`. Read once; a failure leaves it empty.
    private(set) var knownRepos: [KnownRepo] = []
    private var reposLoaded = false
    private(set) var listLoading = false
    private var listGeneration = 0

    /// The open workspace; nil shows the list.
    private(set) var workspace: ReviewWorkspaceModel?
    private let serverDefaults: ServerDefaults
    private static let selectedKey = "review.selected"

    init(app: AppModel, client: YarvisClient) {
        self.app = app
        self.client = client
        serverDefaults = ServerDefaults(server: client.baseURL)
        if let saved = serverDefaults.string(Self.selectedKey) { select(saved) }
        resync()
    }

    func stop() {
        workspace?.stop()
        workspace = nil
    }

    /// The review routes send no server events, so this only passes on PTY
    /// starts and exits, which can be the workspace's Ask Claude session.
    func handle(_ event: ServerEvent) {
        workspace?.handle(event)
    }

    func resync() {
        Task { await refreshList() }
        workspace?.reload()
    }

    /// The page came on screen.
    func appeared() {
        Task { await refreshList() }
        workspace?.reload()
    }

    /// Polls run only while the user can see the page.
    var pageVisible: Bool {
        guard app.section == .review, NSApp.isActive,
              let window = NSApp.mainWindow ?? NSApp.keyWindow else { return false }
        return window.occlusionState.contains(.visible)
    }

    // MARK: The list

    func refreshList() async {
        listGeneration += 1
        let generation = listGeneration
        listLoading = true
        defer { if generation == listGeneration { listLoading = false } }
        do {
            let list = try await client.reviewWorkspaces()
            let old = showArchived ? try await client.reviewWorkspaces(archived: true) : archived
            guard generation == listGeneration else { return }
            workspaces = list
            archived = old
            error = nil
        } catch {
            guard generation == listGeneration else { return }
            self.error = error.localizedDescription
        }
    }

    /// Active workspaces first, most recently opened first; archived ones
    /// after them when shown.
    var shownWorkspaces: [ReviewWorkspace] {
        sortedReviewWorkspaces(workspaces.filter { $0.status != "archived" })
            + (showArchived ? sortedReviewWorkspaces(archived) : [])
    }

    func loadRepos() {
        guard !reposLoaded else { return }
        reposLoaded = true
        Task {
            if let repos = try? await client.repos() {
                knownRepos = repos.map { KnownRepo(owner: $0.owner, repo: $0.repo) }
            }
        }
    }

    /// Removes the checkouts and puts the workspace under Show archived.
    func archive(_ id: String) async throws {
        try await client.archiveReviewWorkspace(id: id)
        if workspace?.id == id {
            closeWorkspace(forget: true)
        } else {
            ReviewWorkspaceModel.forgetSaved(id: id, server: client.baseURL)
            await refreshList()
        }
    }

    // MARK: Selection and routing

    /// Shows a workspace, or the list for nil.
    func select(_ id: String?) {
        serverDefaults.set(id, Self.selectedKey)
        guard id != workspace?.id else { return }
        workspace?.stop()
        workspace = id.map { ReviewWorkspaceModel(page: self, client: client, id: $0) }
    }

    /// Shows the workspace with `prId` brought forward, for a link, an
    /// attention item or a PR's "Open in review workspace".
    func open(_ request: OpenReviewRequest) {
        select(request.workspaceId)
        if let prId = request.prId {
            workspace?.focus(prId: prId, tab: request.tab ?? .description)
        }
    }

    /// The workspace closed itself: archived, or gone from the server.
    func closeWorkspace(forget: Bool) {
        if forget, let id = workspace?.id { ReviewWorkspaceModel.forgetSaved(id: id, server: client.baseURL) }
        select(nil)
        Task { await refreshList() }
    }

    /// Opens `ref` in the active workspace already holding it, or in a new
    /// one named after it. The clone runs in the background.
    func openPr(_ ref: PrRef, title: String? = nil, tab: ReviewTabSpec.Kind? = nil) async throws {
        let list = try await client.reviewWorkspaces()
        if let found = findReviewWorkspace(holding: ref, in: list) {
            app.openReview(OpenReviewRequest(workspaceId: found.workspaceId, prId: found.prId, tab: tab))
            return
        }
        let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let ws = try await client.createReviewWorkspace(name: trimmed.isEmpty ? shortPrName(ref) : trimmed, refs: [ref])
        workspaces.insert(ws, at: 0)
        app.openReview(OpenReviewRequest(workspaceId: ws.id, prId: ws.prs.first?.id, tab: tab))
    }

    /// Adds `ref` to an existing workspace and shows it there.
    func addPr(_ ref: PrRef, toWorkspace workspaceId: String) async throws {
        let pr = try await client.addReviewPr(workspaceId: workspaceId, ref: ref)
        if workspace?.id == workspaceId { workspace?.reload() }
        app.openReview(OpenReviewRequest(workspaceId: workspaceId, prId: pr.id))
    }
}
