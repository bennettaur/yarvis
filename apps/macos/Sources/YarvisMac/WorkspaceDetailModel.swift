import AppKit
import Foundation
import Observation
import YarvisClient

/// A tab in the main area beside the side panel. The terminal surface is
/// always first; diffs, editors and setup logs open beside it.
enum WorkspaceTab: Hashable, Identifiable {
    case terminals
    /// `worktree` is nil for the workspace's own worktree, else another
    /// worktree's absolute path.
    case diff(repo: String, path: String, worktree: String?)
    case editor(repo: String, path: String, worktree: String?)
    case setupLog(repo: String)

    var id: Self { self }
}

enum WorkspaceSideTab: String, CaseIterable, Identifiable {
    case files = "All files"
    case changed = "Changed"
    case comments = "Comments"
    case checks = "PR checks"

    var id: String { rawValue }
}

/// One open workspace. Made fresh each time a workspace is selected, so a
/// closed agent tab or an auto-start already done applies only to that
/// visit, and reopening the workspace brings the agent back.
///
/// Once stopped it must not touch the workspace's terminal surface, which the
/// next visit's model shares: every task it starts is cancelled, and anything
/// that lands after a cancel checks `stopped` first.
@MainActor @Observable
final class WorkspaceDetailModel {
    let id: String
    // Weak: a load can finish after sign-out has dropped the page.
    private(set) weak var page: WorkspacesModel?
    unowned let app: AppModel
    let client: YarvisClient

    var detail: WorkspaceDetail?
    /// Set when the first load failed; later poll failures keep the last detail.
    var loadError: String?
    /// The last header action's failure: rename, link, archive and the like.
    var actionError: String?
    /// False while the header shows only what the list row knew.
    private(set) var detailLoaded = false
    var showArchive = false

    // Agent: see WorkspaceDetailModel+Agent.swift.
    var agent = WorkspaceAgentState()
    var liveHarness: AgentHarness?
    var agentConfig = AgentConfig.fallback
    var agentConfigError: String?
    var pickedHarness: String?
    var agentError: String?
    var startingAgent = false

    // Provisioning
    /// The live provision log; nil when no provision stream is open.
    private(set) var provisionLog: String?
    var provisionError: String?
    var ignoreError: String?
    private var autoProvisioned = false
    private var setupLogOpened = false
    private var provisionTask: Task<Void, Never>?

    // PRs
    private(set) var sync: [String: SyncStatus] = [:]
    private(set) var detectNote: (text: String, isError: Bool)?
    private(set) var detecting = false
    var prErrors: [String: String] = [:]

    // Main tabs
    private(set) var tabs: [WorkspaceTab] = [.terminals]
    private(set) var selectedTab: WorkspaceTab = .terminals
    private(set) var diffs: [WorkspaceTab: WorkspaceDiffModel] = [:]
    private(set) var editors: [WorkspaceTab: WorkspaceEditorModel] = [:]
    /// A pane to bring into view once the surface has it, such as the agent
    /// before its first liveness answer.
    var pendingFocus: String?
    private(set) var surface: TerminalSurfaceModel?

    // Side panel
    var sideTab: WorkspaceSideTab = .changed {
        didSet { spawn { await self.refreshSide() } }
    }
    private var pickedSide: SideSelection?
    private(set) var worktrees: [WorktreeListing] = []
    private(set) var worktreeListingFailed = false
    /// Keyed by `SideSelection.value`, with each list's tree built once.
    private(set) var changes: [String: [ChangedFile]] = [:]
    private(set) var changeTrees: [String: [FileTreeNode]] = [:]
    private(set) var files: [String: [String]] = [:]
    private(set) var fileTrees: [String: [FileTreeNode]] = [:]
    private(set) var sideError: String?
    private(set) var comments: [ReviewComment] = []
    var commentsError: String?

    private(set) var stopped = false
    private var polls: [Task<Void, Never>] = []
    private var oneOffs: [UUID: Task<Void, Never>] = [:]
    /// Bumped per detail read, so an older answer that lands last is dropped.
    private var detailGeneration = 0

    init(page: WorkspacesModel, app: AppModel, client: YarvisClient, id: String) {
        self.page = page
        self.app = app
        self.client = client
        self.id = id
        // The list row paints the header while the detail loads.
        if let row = page.workspaces.first(where: { $0.id == id }) {
            detail = WorkspaceDetail(id: row.id, name: row.name, status: row.status, rootPath: row.rootPath,
                                     summary: row.summary, mergedPrUrl: row.mergedPrUrl, error: row.error)
        }
        start()
    }

    func stop() {
        stopped = true
        polls.forEach { $0.cancel() }
        polls = []
        oneOffs.values.forEach { $0.cancel() }
        oneOffs = [:]
        provisionTask?.cancel()
        surface?.onClosePinned = nil
    }

    /// Runs `body` as a task that `stop()` cancels.
    func spawn(_ body: @escaping @MainActor () async -> Void) {
        guard !stopped else { return }
        let key = UUID()
        oneOffs[key] = Task { [weak self] in
            await body()
            self?.oneOffs[key] = nil
        }
    }

    private func start() {
        spawn { await self.loadAgentConfig() }
        reload()
        polls = [
            poll(immediately: false, every: { [weak self] in
                self?.detail?.isTearingDown == true ? .seconds(2) : .seconds(20)
            }) { [weak self] in await self?.refreshDetail(background: true) },
            poll(every: .seconds(4)) { [weak self] in
                guard let self, self.detail?.isActive == true else { return }
                await self.refreshAgent()
            },
            poll(every: .seconds(5)) { [weak self] in await self?.refreshSide() },
            poll(every: .seconds(5)) { [weak self] in await self?.refreshComments() },
            poll(every: .seconds(30)) { [weak self] in await self?.refreshSync() },
            poll(every: .seconds(15)) { [weak self] in await self?.refreshWorktrees() },
        ]
    }

    private func poll(immediately: Bool = true, every interval: Duration,
                      _ body: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        poll(immediately: immediately, every: { interval }, body)
    }

    /// Runs `body` every `interval` (and at once, unless told not to) while
    /// the page is on screen. The interval is read before each wait, for a
    /// poll that speeds up during a teardown.
    private func poll(immediately: Bool = true, every interval: @escaping @MainActor () -> Duration,
                      _ body: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        Task { [weak self] in
            var first = immediately
            while !Task.isCancelled {
                if !first { try? await Task.sleep(for: interval()) }
                first = false
                guard let self, !Task.isCancelled, !self.stopped else { return }
                if self.page?.pageVisible == true { await body() }
            }
        }
    }

    /// The page came back on screen: read what may have changed while it wasn't.
    func appeared() {
        spawn {
            await self.refreshDetail(background: true)
            await self.refreshSide()
        }
    }

    func reload() {
        spawn { await self.refreshDetail(background: false) }
    }

    // MARK: Loading

    var summary: WorkspaceSummary? { detail?.summaryRow }

    var repoNames: (String) -> String? {
        let repos = detail?.repos ?? []
        return { workspaceRepoId in repos.count > 1 ? repos.first { $0.id == workspaceRepoId }?.repo.name : nil }
    }

    func repo(_ workspaceRepoId: String) -> WorkspaceRepoDetail? {
        detail?.repos.first { $0.id == workspaceRepoId }
    }

    func refreshDetail(background: Bool) async {
        detailGeneration += 1
        let generation = detailGeneration
        do {
            let fresh = try await client.workspace(id: id, viewing: page?.userIsLooking ?? false)
            guard !stopped, generation == detailGeneration else { return }
            let changedStatus = detail != nil && detail?.status != fresh.status
            if fresh != detail { detail = fresh }
            detailLoaded = true
            loadError = nil
            ensureSurface()
            afterDetailLoad()
            if changedStatus { await page?.refresh(background: true) }
        } catch {
            guard !stopped, generation == detailGeneration else { return }
            if !background || !detailLoaded { loadError = error.localizedDescription }
        }
    }

    private func afterDetailLoad() {
        guard let detail else { return }
        if detail.status == "creating", provisionLog == nil, !autoProvisioned {
            autoProvisioned = true
            provision()
        }
        if let failed = setupLogToAutoOpen(detail, alreadyOpened: setupLogOpened) {
            setupLogOpened = true
            openTab(.setupLog(repo: failed.id))
        }
        updatePinned()
    }

    // MARK: Side panel

    /// What the side panel reads: the picked repo and worktree while that
    /// repo is ready, else the first ready repo's own worktree.
    var side: SideSelection? {
        let ready = detail?.readyRepos ?? []
        if let picked = pickedSide, ready.contains(where: { $0.id == picked.workspaceRepoId }) { return picked }
        return ready.first.map { SideSelection(workspaceRepoId: $0.id) }
    }

    var sideRepo: WorkspaceRepoDetail? { side.flatMap { repo($0.workspaceRepoId) } }
    var sideWorktree: String? { side?.worktree }

    /// The side panel's repo and worktree as one picker value.
    var sideSelection: String {
        get { side?.value ?? "" }
        set {
            guard let picked = SideSelection(value: newValue), picked != side else { return }
            pickedSide = picked
            spawn { await self.refreshSide() }
        }
    }

    /// The selectable worktrees, the workspace's own first in each repo.
    func worktreeOptions(_ repo: WorkspaceRepoDetail) -> [WorktreeListing.Worktree] {
        let listed = worktrees.first { $0.workspaceRepoId == repo.id }?.worktrees.filter { !$0.primary } ?? []
        return [WorktreeListing.Worktree(path: "", branch: repo.branch, primary: true)] + listed
    }

    private func refreshWorktrees() async {
        guard detail?.isActive == true else { return }
        do {
            let listed = try await client.workspaceWorktrees(id: id)
            guard !stopped else { return }
            if listed != worktrees { worktrees = listed }
            worktreeListingFailed = listed.contains { $0.error != nil }
            if let current = side, current.keepingListed(listed) != current {
                pickedSide = current.keepingListed(listed)
                await refreshSide()
            }
        } catch {
            if !stopped { worktreeListingFailed = true }
        }
    }

    private func refreshSide() async {
        guard let selection = side else { return }
        let key = selection.value
        let tab = sideTab
        do {
            switch tab {
            case .changed:
                let fresh = try await client.workspaceChanges(id: id, repo: selection.workspaceRepoId,
                                                              worktree: selection.worktree)
                guard !stopped else { return }
                if fresh != changes[key] {
                    changes[key] = fresh
                    changeTrees[key] = buildFileTree(fresh.map(\.path))
                }
            case .files:
                let fresh = try await client.workspaceFiles(id: id, repo: selection.workspaceRepoId,
                                                            worktree: selection.worktree)
                guard !stopped else { return }
                if fresh != files[key] {
                    files[key] = fresh
                    fileTrees[key] = buildFileTree(fresh)
                }
            case .comments, .checks:
                return
            }
            if sideError != nil { sideError = nil }
        } catch {
            // A poll that fails keeps what is on screen; only an empty view says why.
            guard !stopped else { return }
            let empty = tab == .changed ? changes[key] == nil : files[key] == nil
            if empty { sideError = error.localizedDescription }
        }
    }

    func refreshComments() async {
        do {
            let fresh = try await client.reviewComments(workspaceId: id)
            guard !stopped else { return }
            if fresh != comments { comments = fresh }
            if commentsError != nil { commentsError = nil }
        } catch {
            if !stopped, comments.isEmpty { commentsError = error.localizedDescription }
        }
    }

    private func refreshSync() async {
        guard let detail, detail.isActive else { return }
        for repo in detail.readyRepos {
            guard let fresh = try? await client.workspaceSync(id: id, repo: repo.id), !stopped else { continue }
            if sync[repo.id] != fresh { sync[repo.id] = fresh }
        }
    }

    // MARK: Terminals and tabs

    private func ensureSurface() {
        guard !stopped, surface == nil, let detail, let page else { return }
        let surface = page.surface(workspaceId: id, rootPath: detail.rootPath)
        surface.onClosePinned = { [weak self] _ in self?.closeAgent() }
        self.surface = surface
        updatePinned()
    }

    /// Pins the agent's tab while it runs. Nothing changes before the first
    /// liveness answer, so revisiting a workspace doesn't drop the tab and
    /// put it back.
    func updatePinned() {
        guard !stopped, let surface, agent.probed else { return }
        let pinned = agent.showsTab
            ? [PinnedTerminalTab(key: "agent", title: liveHarness?.name ?? agentConfig.name, sessionId: agentSessionId)]
            : []
        if surface.pinned != pinned { surface.pinned = pinned }
        // An agent restarted between two checks keeps the same pin, so its
        // ended terminal is replaced here rather than only on the next click.
        if let active = surface.activePinned { surface.attach(active) }
        guard let key = pendingFocus else { return }
        if surface.focus(sessionKey: key) { selectedTab = .terminals }
        // Tried once the agent's state is known: a key the surface still
        // doesn't have is gone, not late.
        pendingFocus = nil
    }

    /// Brings a terminal pane or the agent into view. Before the first
    /// liveness answer the agent's tab isn't pinned, so the key waits for it.
    func focus(sessionKey: String) {
        selectedTab = .terminals
        guard surface?.focus(sessionKey: sessionKey) != true else { return }
        pendingFocus = sessionKey
        updatePinned()
    }

    /// The user picked a tab, which overrides a focus still waiting.
    func select(_ tab: WorkspaceTab) {
        pendingFocus = nil
        selectedTab = tab
    }

    func openTab(_ tab: WorkspaceTab) {
        if !tabs.contains(tab) {
            tabs.append(tab)
            switch tab {
            case .diff(let repo, let path, let worktree):
                diffs[tab] = WorkspaceDiffModel(detail: self, client: client, workspaceId: id, workspaceRepoId: repo,
                                                path: path, worktree: worktree)
            case .editor(let repo, let path, let worktree):
                editors[tab] = WorkspaceEditorModel(app: app, client: client, workspaceId: id, workspaceRepoId: repo,
                                                    path: path, worktree: worktree)
            case .terminals, .setupLog:
                break
            }
        }
        select(tab)
    }

    func closeTab(_ tab: WorkspaceTab) {
        guard tab != .terminals else { return }
        if let editor = editors[tab], editor.dirty {
            let alert = NSAlert()
            alert.messageText = "Close \((editor.path as NSString).lastPathComponent) without saving?"
            alert.informativeText = "Your edits to this file will be lost."
            alert.addButton(withTitle: "Close")
            alert.addButton(withTitle: "Cancel")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        tabs.removeAll { $0 == tab }
        diffs[tab]?.stop()
        diffs[tab] = nil
        editors[tab]?.stop()
        editors[tab] = nil
        if selectedTab == tab { selectedTab = tabs.last ?? .terminals }
    }

    func tabTitle(_ tab: WorkspaceTab) -> String {
        switch tab {
        case .terminals: return "Terminals"
        case .diff(let repo, let path, let worktree):
            return "Δ " + (path as NSString).lastPathComponent + branchSuffix(repo, worktree)
        case .editor(let repo, let path, let worktree):
            let dirty = editors[tab]?.dirty == true ? " ●" : ""
            return (path as NSString).lastPathComponent + branchSuffix(repo, worktree) + dirty
        case .setupLog(let repo): return "setup · \(self.repo(repo)?.repo.name ?? "repo")"
        }
    }

    /// ` · <branch>` for a tab on another worktree, so two copies of a file read apart.
    private func branchSuffix(_ repo: String, _ worktree: String?) -> String {
        guard let worktree else { return "" }
        let branch = worktrees.first { $0.workspaceRepoId == repo }?.worktrees.first { $0.path == worktree }?.branch
        return " · \(branch ?? "detached HEAD")"
    }

    // MARK: Actions

    /// Runs a write, asking for a code if the server wants one, and reports
    /// the failure (or nil) through `onError`. False on failure, or when the
    /// model stopped while it ran.
    func perform(_ onError: @escaping @MainActor (String?) -> Void = { _ in },
                 _ action: @escaping @Sendable () async throws -> Void) async -> Bool {
        do {
            try await app.withFreshCode(action)
            if !stopped { onError(nil) }
            return !stopped
        } catch {
            if !stopped { onError(error.localizedDescription) }
            return false
        }
    }

    /// Reads the workspace, and the list unless told not to, after a change made here.
    private func reloadAfterChange(list: Bool = true) async {
        await refreshDetail(background: true)
        if list, !stopped { await page?.refresh(background: true) }
    }

    /// Renames the workspace. Returns the failure, or nil.
    func rename(to name: String) async -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != detail?.name else { return nil }
        var failure: String?
        if await perform({ failure = $0 }, { [client = self.client, id = self.id] in try await client.renameWorkspace(id: id, name: trimmed) }) {
            await reloadAfterChange()
        }
        return failure
    }

    func provision() {
        provisionLog = ""
        provisionError = nil
        ignoreError = nil
        provisionTask?.cancel()
        provisionTask = Task {
            do {
                for try await event in try client.provisionStream(id: id) {
                    if let text = provisionLogText(event) { provisionLog = (provisionLog ?? "") + text }
                    if case .error(let message) = event { provisionError = message }
                }
            } catch {
                if !Task.isCancelled { provisionError = error.localizedDescription }
            }
            // A cancel ends the loop without throwing, so it is told apart
            // from the run finishing here.
            guard !Task.isCancelled, !stopped else { return }
            provisionLog = nil
            setupLogOpened = false
            await reloadAfterChange()
        }
    }

    func ignoreFailure() {
        spawn {
            if await self.perform({ self.ignoreError = $0 }, { [client = self.client, id = self.id] in
                try await client.ignoreWorkspaceError(id: id)
            }) {
                await self.reloadAfterChange()
            }
        }
    }

    /// Starts the archive. Returns the failure, or nil.
    func archive(_ request: ArchiveRequest) async -> String? {
        var failure: String?
        if await perform({ failure = $0 }, { [client = self.client, id = self.id] in try await client.archiveWorkspace(id: id, request) }) {
            await reloadAfterChange()
        }
        return failure
    }

    func detectPrs() {
        detecting = true
        spawn {
            defer { self.detecting = false }
            do {
                let result = try await self.app.withFreshCode { [client = self.client, id = self.id] in
                    try await client.detectWorkspacePrs(id: id)
                }
                guard !self.stopped else { return }
                self.detectNote = detectPrsNote(result)
                await self.refreshDetail(background: true)
            } catch {
                if !self.stopped { self.detectNote = (error.localizedDescription, true) }
            }
        }
    }

    /// Links a PR by number. Returns the failure, or nil.
    func linkPr(repo workspaceRepoId: String, input: String) async -> String? {
        guard let number = parsePrNumberInput(input) else { return "Enter a PR number, such as 123." }
        var failure: String?
        if await perform({ failure = $0 }, { [client = self.client, id = self.id] in
            try await client.linkWorkspacePr(id: id, repo: workspaceRepoId, number: number)
        }) {
            await reloadAfterChange(list: false)
        }
        return failure
    }

    func unlinkPr(repo workspaceRepoId: String, number: Int) {
        spawn {
            if await self.perform({ self.prErrors[workspaceRepoId] = $0 }, { [client = self.client, id = self.id] in
                try await client.unlinkWorkspacePr(id: id, repo: workspaceRepoId, number: number)
            }) {
                await self.reloadAfterChange(list: false)
            }
        }
    }

    func unlinkTask(_ task: WorkspaceTask) {
        spawn {
            if await self.perform({ self.actionError = $0 }, { [client = self.client, id = self.id] in
                try await client.unlinkWorkspaceTask(id: id, taskId: task.id)
            }) {
                await self.reloadAfterChange(list: false)
            }
        }
    }

    func unlinkIssue(_ issue: IssueLink) {
        spawn {
            if await self.perform({ self.actionError = $0 }, { [client = self.client, id = self.id] in
                try await client.unlinkWorkspaceIssue(id: id, issue)
            }) {
                await self.reloadAfterChange(list: false)
            }
        }
    }

    // MARK: Review comments

    var openCommentCount: Int { comments.filter { !$0.isResolved }.count }

    func comments(repo workspaceRepoId: String, path: String) -> [ReviewComment] {
        comments.filter { $0.workspaceRepoId == workspaceRepoId && $0.path == path }
    }

    /// Saves a comment. Returns the failure, or nil.
    func addComment(repo workspaceRepoId: String, path: String, startLine: Int, endLine: Int,
                    body: String) async -> String? {
        do {
            let saved = try await app.withFreshCode { [client = self.client, id = self.id] in
                try await client.createReviewComment(workspaceId: id, repo: workspaceRepoId, path: path,
                                                     startLine: startLine, endLine: endLine, body: body)
            }
            if !stopped { comments.append(saved) }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func setResolved(_ comment: ReviewComment, _ resolved: Bool) {
        spawn {
            do {
                let updated = try await self.app.withFreshCode { [client = self.client, id = self.id] in
                    try await client.setReviewCommentResolved(workspaceId: id, commentId: comment.id, resolved: resolved)
                }
                guard !self.stopped else { return }
                if let i = self.comments.firstIndex(where: { $0.id == comment.id }) { self.comments[i] = updated }
            } catch {
                if !self.stopped { self.commentsError = error.localizedDescription }
            }
        }
    }

    func deleteComment(_ comment: ReviewComment) {
        spawn {
            if await self.perform({ self.commentsError = $0 }, { [client = self.client, id = self.id] in
                try await client.deleteReviewComment(workspaceId: id, commentId: comment.id)
            }) {
                self.comments.removeAll { $0.id == comment.id }
            }
        }
    }

    /// Puts the open comments on the clipboard for pasting into the agent.
    func copyCommentsForClaude() -> Bool {
        let text = formatReviewComments(comments, repoName: repoNames)
        guard !text.isEmpty else { return false }
        return copyToPasteboard(text)
    }
}
