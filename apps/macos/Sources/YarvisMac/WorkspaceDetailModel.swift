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

/// One open workspace. Made fresh each time a workspace is selected, so
/// per-view state (a dismissed agent, an auto-start already done) resets on
/// reopening, as it does in the web UI.
@MainActor @Observable
final class WorkspaceDetailModel {
    let id: String
    private unowned let page: WorkspacesModel
    private unowned let app: AppModel
    private let client: YarvisClient

    var detail: WorkspaceDetail?
    /// Set when the first load failed; later poll failures keep the last detail.
    var loadError: String?
    /// The last header action's failure: rename, link, archive and the like.
    var actionError: String?

    // Agent
    private(set) var agentActive = false
    private(set) var probed = false
    private(set) var dismissed = false
    private var startedHere = false
    private(set) var liveHarness: AgentHarness?
    private(set) var agentConfig = AgentConfig.fallback
    private(set) var agentConfigError: String?
    var pickedHarness: String?
    var agentError: String?
    private(set) var startingAgent = false

    // Provisioning
    /// The live provision log; nil when no provision stream is open.
    private(set) var provisionLog: String?
    var provisionError: String?
    var ignoreError: String?
    private var autoProvisioned = false
    private var setupLogOpened = false

    // PRs
    private(set) var sync: [String: SyncStatus] = [:]
    private(set) var detectNote: (text: String, isError: Bool)?
    private(set) var detecting = false
    var prErrors: [String: String] = [:]

    // Main tabs
    private(set) var tabs: [WorkspaceTab] = [.terminals]
    var selectedTab: WorkspaceTab = .terminals
    private(set) var diffs: [WorkspaceTab: WorkspaceDiffModel] = [:]
    private(set) var editors: [WorkspaceTab: WorkspaceEditorModel] = [:]
    private var pendingFocus: String?

    // Side panel
    var sideTab: WorkspaceSideTab = .changed {
        didSet { Task { await refreshSide() } }
    }
    private(set) var sideRepoId: String?
    /// The other worktree the side panel reads, or nil for the workspace's own.
    private(set) var sideWorktree: String?
    private(set) var worktrees: [WorktreeListing] = []
    private(set) var worktreeListingFailed = false
    private(set) var changes: [String: [ChangedFile]] = [:]
    private(set) var files: [String: [String]] = [:]
    private(set) var sideError: String?
    private(set) var comments: [ReviewComment] = []
    var commentsError: String?

    var showArchive = false
    /// False while the header shows only what the list row knew.
    private(set) var detailLoaded = false

    private var tasks: [Task<Void, Never>] = []
    private var surfaceModel: TerminalSurfaceModel?

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
        tasks.forEach { $0.cancel() }
        tasks = []
        provisionTask?.cancel()
        surfaceModel?.onClosePinned = nil
    }

    private func start() {
        Task { await loadAgentConfig() }
        reload()
        tasks.append(poll(immediately: false, every: { [weak self] in
            let d = self?.detail
            return d?.status == "archiving" && d?.error == nil ? 2 : 20
        }) { [weak self] in await self?.refreshDetail(background: true) })
        tasks.append(poll(every: { 4 }) { [weak self] in
            guard let self, self.detail?.status == "active" else { return }
            await self.refreshAgent()
        })
        tasks.append(poll(every: { 5 }) { [weak self] in await self?.refreshSide() })
        tasks.append(poll(every: { 5 }) { [weak self] in await self?.refreshComments() })
        tasks.append(poll(every: { 30 }) { [weak self] in await self?.refreshSync() })
        tasks.append(poll(every: { 15 }) { [weak self] in await self?.refreshWorktrees() })
    }

    /// Runs `body` every `seconds` (and at once, unless told not to) while
    /// the page is on screen.
    private func poll(immediately: Bool = true, every seconds: @escaping @MainActor () -> Double,
                      _ body: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        Task { [weak self] in
            var first = immediately
            while !Task.isCancelled {
                if !first { try? await Task.sleep(for: .seconds(seconds())) }
                first = false
                guard let self, !Task.isCancelled else { return }
                if self.page.pageVisible { await body() }
            }
        }
    }

    func appeared() {
        Task {
            await refreshDetail(background: true)
            await refreshSide()
        }
    }

    func reload() {
        Task { await refreshDetail(background: false) }
    }

    // MARK: Loading

    var summary: WorkspaceSummary? { detail?.summaryRow }

    var repoNames: (String) -> String? {
        let repos = detail?.repos ?? []
        return { wrId in repos.count > 1 ? repos.first { $0.id == wrId }?.repo.name : nil }
    }

    func repo(_ wrId: String) -> WorkspaceRepoDetail? { detail?.repos.first { $0.id == wrId } }

    var sideRepo: WorkspaceRepoDetail? {
        let ready = detail?.repos.filter { $0.status == "ready" } ?? []
        return ready.first { $0.id == sideRepoId } ?? ready.first
    }

    private func refreshDetail(background: Bool) async {
        do {
            let fresh = try await client.workspace(id: id, viewing: page.userIsLooking)
            let changedStatus = detail != nil && detail?.status != fresh.status
            detail = fresh
            detailLoaded = true
            loadError = nil
            ensureSurface()
            if changedStatus { await page.refresh(background: true) }
            afterDetailLoad()
        } catch {
            if !background || !detailLoaded {
                loadError = error.localizedDescription
            }
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

    /// What the side panel's file lists are stored under: the repo and worktree.
    var sideKey: String? { sideRepo.map { "\($0.id)|\(sideWorktree ?? "")" } }

    /// The side panel's repo and worktree as one picker value.
    var sideSelection: String {
        get { sideKey ?? "" }
        set {
            let parts = newValue.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
            sideRepoId = parts.first.map(String.init)
            sideWorktree = parts.count > 1 && !parts[1].isEmpty ? String(parts[1]) : nil
            Task { await refreshSide() }
        }
    }

    /// The selectable worktrees, the workspace's own first in each repo.
    func worktreeOptions(_ repo: WorkspaceRepoDetail) -> [WorktreeListing.Worktree] {
        let listed = worktrees.first { $0.workspaceRepoId == repo.id }?.worktrees.filter { !$0.primary } ?? []
        return [WorktreeListing.Worktree(path: "", branch: repo.branch, primary: true)] + listed
    }

    private func refreshWorktrees() async {
        guard detail?.status == "active" else { return }
        do {
            worktrees = try await client.workspaceWorktrees(id: id)
            worktreeListingFailed = worktrees.contains { $0.error != nil }
            // A worktree that went away drops the panel back to the workspace's own.
            if let path = sideWorktree, let repo = sideRepo,
               !worktreeOptions(repo).contains(where: { $0.path == path }) {
                sideWorktree = nil
                await refreshSide()
            }
        } catch {
            worktreeListingFailed = true
        }
    }

    private func refreshSide() async {
        guard let repo = sideRepo, let key = sideKey else { return }
        let worktree = sideWorktree
        do {
            switch sideTab {
            case .changed:
                changes[key] = try await client.workspaceChanges(id: id, repo: repo.id, worktree: worktree)
            case .files:
                files[key] = try await client.workspaceFiles(id: id, repo: repo.id, worktree: worktree)
            case .comments, .checks:
                return
            }
            sideError = nil
        } catch {
            // A poll that fails keeps what is on screen; only an empty view says why.
            let empty = sideTab == .changed ? changes[key] == nil : files[key] == nil
            if empty { sideError = error.localizedDescription }
        }
    }

    func refreshComments() async {
        do {
            comments = try await client.reviewComments(workspaceId: id)
            commentsError = nil
        } catch {
            if comments.isEmpty { commentsError = error.localizedDescription }
        }
    }

    private func refreshSync() async {
        guard detail?.status == "active" else { return }
        for repo in detail?.repos.filter({ $0.status == "ready" }) ?? [] {
            if let s = try? await client.workspaceSync(id: id, repo: repo.id) { sync[repo.id] = s }
        }
    }

    // MARK: Agent

    private var agentSessionId: String { WorkspaceSummary.agentSessionId(workspaceId: id) }

    private func loadAgentConfig() async {
        do {
            agentConfig = try await client.agentConfig()
        } catch {
            agentConfigError = "Could not load the configured agent (\(error.localizedDescription)); using the default."
        }
    }

    /// Reads whether the agent runs, then starts it on a first open with none.
    func probeAgent() {
        Task { await refreshAgent() }
    }

    private func refreshAgent() async {
        guard let active = try? await client.ptyExists(agentSessionId) else { return }
        let changed = active != agentActive || !probed
        agentActive = active
        probed = true
        if changed {
            liveHarness = active ? (try? await client.ptySessionHarness(agentSessionId)) ?? nil : nil
        }
        updatePinned()
        if shouldAutoStartAgent(dismissed: dismissed, workspaceStatus: detail?.status ?? "", probed: probed,
                                agentActive: agentActive, alreadyStarted: startedHere) {
            startAgent()
        }
    }

    /// Whether to offer the harness picker: several harnesses and no live agent.
    var showsHarnessPicker: Bool {
        detail?.status == "active" && !agentActive && agentConfig.harnesses.count > 1
    }

    var showsStartButton: Bool { detail?.status == "active" && (!agentActive || dismissed) }

    var startButtonLabel: String {
        let name = agentActive ? (liveHarness?.name ?? agentConfig.name)
            : (chosenHarness(agentConfig, picked: pickedHarness)?.name ?? agentConfig.name)
        return "Start \(name) session"
    }

    /// Starts the agent, or brings back a live one the user closed the tab of.
    func startAgent() {
        guard let summary else { return }
        dismissed = false
        startedHere = true
        agentError = nil
        if agentActive {
            updatePinned()
            selectedTab = .terminals
            return
        }
        let harness = agentConfig.harnesses.count > 1 ? chosenHarness(agentConfig, picked: pickedHarness)?.id : nil
        startingAgent = true
        Task {
            defer { startingAgent = false }
            do {
                try await app.withFreshCode { [client] in
                    try await client.startAgentSession(workspace: summary, harness: harness)
                }
                await refreshAgent()
                selectedTab = .terminals
            } catch {
                agentError = error.localizedDescription
            }
        }
    }

    /// The user closed the agent's tab: end the session, and tell the
    /// sidecar so a restart doesn't resume it.
    private func closeAgent() {
        dismissed = true
        updatePinned()
        let id = id
        let sessionId = agentSessionId
        Task {
            do {
                try await app.withFreshCode { [client] in try await client.ptyKill(sessionId) }
                try await client.stopWorkspaceAgent(id: id)
            } catch {
                agentError = error.localizedDescription
            }
            await refreshAgent()
        }
    }

    // MARK: Terminals and tabs

    var surface: TerminalSurfaceModel? { surfaceModel }

    private func ensureSurface() {
        guard surfaceModel == nil, let detail else { return }
        let surface = page.surface(workspaceId: id, rootPath: detail.rootPath)
        surface.onClosePinned = { [weak self] _ in self?.closeAgent() }
        surfaceModel = surface
        updatePinned()
    }

    private func updatePinned() {
        guard let surfaceModel else { return }
        let title = liveHarness?.name ?? agentConfig.name
        let pinned = agentActive && !dismissed
            ? [PinnedTerminalTab(key: "agent", title: title, sessionId: agentSessionId)] : []
        if surfaceModel.pinned != pinned { surfaceModel.pinned = pinned }
        if let key = pendingFocus, surfaceModel.focus(sessionKey: key) {
            pendingFocus = nil
            selectedTab = .terminals
        }
    }

    /// Brings a terminal pane or the agent into view. The agent's tab may not
    /// be pinned yet, so the key is kept until it is.
    func focus(sessionKey: String) {
        selectedTab = .terminals
        if surfaceModel?.focus(sessionKey: sessionKey) != true { pendingFocus = sessionKey }
    }

    func openTab(_ tab: WorkspaceTab) {
        if !tabs.contains(tab) {
            tabs.append(tab)
            switch tab {
            case .diff(let repo, let path, let worktree):
                diffs[tab] = WorkspaceDiffModel(detail: self, client: client, workspaceId: id, repoId: repo,
                                                path: path, worktree: worktree)
            case .editor(let repo, let path, let worktree):
                editors[tab] = WorkspaceEditorModel(app: app, client: client, workspaceId: id, repoId: repo,
                                                    path: path, worktree: worktree)
            case .terminals, .setupLog:
                break
            }
        }
        selectedTab = tab
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
        diffs[tab] = nil
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

    /// Runs a write, asking for a code if the server wants one, and shows a
    /// failure through `onError`.
    private func perform(_ onError: @escaping @MainActor (String?) -> Void = { _ in },
                         _ action: @escaping @Sendable () async throws -> Void) async -> Bool {
        do {
            try await app.withFreshCode(action)
            onError(nil)
            return true
        } catch {
            onError(error.localizedDescription)
            return false
        }
    }

    /// Renames the workspace. Returns the failure, or nil.
    func rename(to name: String) async -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != detail?.name else { return nil }
        var failure: String?
        let ok = await perform({ failure = $0 }) { [client, id] in try await client.renameWorkspace(id: id, name: trimmed) }
        if ok {
            await refreshDetail(background: true)
            await page.refresh(background: true)
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
            } catch is CancellationError {
                return
            } catch {
                provisionError = error.localizedDescription
            }
            provisionLog = nil
            setupLogOpened = false
            await refreshDetail(background: true)
            await page.refresh(background: true)
        }
    }

    private var provisionTask: Task<Void, Never>?

    func ignoreFailure() {
        Task {
            if await perform({ self.ignoreError = $0 }, { [client, id] in try await client.ignoreWorkspaceError(id: id) }) {
                await refreshDetail(background: true)
                await page.refresh(background: true)
            }
        }
    }

    func archive(_ request: ArchiveRequest) async -> String? {
        var failure: String?
        let ok = await perform({ failure = $0 }) { [client, id] in try await client.archiveWorkspace(id: id, request) }
        if ok {
            await refreshDetail(background: true)
            await page.refresh(background: true)
        }
        return failure
    }

    func detectPrs() {
        detecting = true
        Task {
            defer { detecting = false }
            do {
                let result = try await app.withFreshCode { [client, id] in try await client.detectWorkspacePrs(id: id) }
                detectNote = detectPrsNote(result)
                await refreshDetail(background: true)
            } catch {
                detectNote = (error.localizedDescription, true)
            }
        }
    }

    /// Links a PR by number. Returns the failure, or nil.
    func linkPr(repo wrId: String, input: String) async -> String? {
        guard let number = parsePrNumberInput(input) else { return "Enter a PR number, such as 123." }
        var failure: String?
        if await perform({ failure = $0 }, { [client, id] in try await client.linkWorkspacePr(id: id, repo: wrId, number: number) }) {
            await refreshDetail(background: true)
        }
        return failure
    }

    func unlinkPr(repo wrId: String, number: Int) {
        Task {
            if await perform({ self.prErrors[wrId] = $0 }, { [client, id] in
                try await client.unlinkWorkspacePr(id: id, repo: wrId, number: number)
            }) {
                await refreshDetail(background: true)
            }
        }
    }

    func unlinkTask(_ task: WorkspaceTask) {
        Task {
            if await perform({ self.actionError = $0 }, { [client, id] in try await client.unlinkWorkspaceTask(id: id, taskId: task.id) }) {
                await refreshDetail(background: true)
            }
        }
    }

    func unlinkIssue(_ issue: IssueLink) {
        Task {
            if await perform({ self.actionError = $0 }, { [client, id] in try await client.unlinkWorkspaceIssue(id: id, issue) }) {
                await refreshDetail(background: true)
            }
        }
    }

    // MARK: Review comments

    var openCommentCount: Int { comments.filter { !$0.isResolved }.count }

    func comments(repo wrId: String, path: String) -> [ReviewComment] {
        comments.filter { $0.workspaceRepoId == wrId && $0.path == path }
    }

    /// Saves a comment. Returns the failure, or nil.
    func addComment(repo wrId: String, path: String, startLine: Int, endLine: Int, body: String) async -> String? {
        do {
            let saved = try await app.withFreshCode { [client, id] in
                try await client.createReviewComment(workspaceId: id, repo: wrId, path: path,
                                                     startLine: startLine, endLine: endLine, body: body)
            }
            comments.append(saved)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func setResolved(_ comment: ReviewComment, _ resolved: Bool) {
        Task {
            do {
                let updated = try await app.withFreshCode { [client, id] in
                    try await client.setReviewCommentResolved(workspaceId: id, commentId: comment.id, resolved: resolved)
                }
                if let i = comments.firstIndex(where: { $0.id == comment.id }) { comments[i] = updated }
            } catch {
                commentsError = error.localizedDescription
            }
        }
    }

    func deleteComment(_ comment: ReviewComment) {
        Task {
            if await perform({ self.commentsError = $0 }, { [client, id] in
                try await client.deleteReviewComment(workspaceId: id, commentId: comment.id)
            }) {
                comments.removeAll { $0.id == comment.id }
            }
        }
    }

    /// Puts the open comments on the clipboard for pasting into the agent.
    func copyCommentsForClaude() -> Bool {
        let text = formatReviewComments(comments, repoName: repoNames)
        guard !text.isEmpty else { return false }
        NSPasteboard.general.clearContents()
        return NSPasteboard.general.setString(text, forType: .string)
    }
}

/// A diff tab: the file's patch, read on open and on Refresh, with the
/// review comments drawn under their lines.
@MainActor @Observable
final class WorkspaceDiffModel {
    let repoId: String
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

    init(detail: WorkspaceDetailModel, client: YarvisClient, workspaceId: String, repoId: String, path: String,
         worktree: String?) {
        self.detail = detail
        self.client = client
        self.workspaceId = workspaceId
        self.repoId = repoId
        self.path = path
        self.worktree = worktree
        refresh()
    }

    var commentable: Bool { worktree == nil }

    var comments: [ReviewComment] { commentable ? detail.comments(repo: repoId, path: path) : [] }

    func refresh() {
        Task {
            do {
                let diff = try await client.workspaceDiff(id: workspaceId, repo: repoId, path: path, worktree: worktree)
                lines = parseUnifiedDiff(diff.patch)
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
            loaded = true
        }
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
        Task {
            defer { saving = false }
            if let failure = await detail.addComment(repo: repoId, path: path, startLine: range.lowerBound,
                                                     endLine: range.upperBound, body: draft) {
                composeError = failure
            } else {
                cancelComment()
            }
        }
    }
}

/// An editor tab for one file. Keyed by file, so a save can never write one
/// file's text over another with a fresh hash.
@MainActor @Observable
final class WorkspaceEditorModel {
    let repoId: String
    let path: String
    let worktree: String?
    private let workspaceId: String
    private let client: YarvisClient
    private unowned let app: AppModel

    var text = ""
    private(set) var savedText = ""
    private(set) var hash: String?
    private(set) var unreadable: String?
    private(set) var size = 0
    private(set) var loaded = false
    private(set) var saving = false
    var error: String?
    /// The file changed on disk since it was opened; the edits are kept.
    var conflict = false

    init(app: AppModel, client: YarvisClient, workspaceId: String, repoId: String, path: String, worktree: String?) {
        self.app = app
        self.client = client
        self.workspaceId = workspaceId
        self.repoId = repoId
        self.path = path
        self.worktree = worktree
        Task { await load(keepText: false) }
    }

    var dirty: Bool { loaded && unreadable == nil && text != savedText }

    var unreadableMessage: String? {
        switch unreadable {
        case "binary": return "This is a binary file."
        case "too-large": return "This file is too large to open in the editor."
        case "encoding": return "This file is not valid UTF-8, so editing it would rewrite the bytes we cannot read."
        case nil: return nil
        case let other?: return "This file can't be edited (\(other))."
        }
    }

    /// Reads the file. `keepText` keeps the user's edits and only takes the
    /// fresh hash, for overwriting after a conflict.
    func load(keepText: Bool) async {
        do {
            let file = try await client.readWorkspaceFile(id: workspaceId, repo: repoId, path: path, worktree: worktree)
            hash = file.hash
            unreadable = file.unreadable
            size = file.size
            savedText = file.content ?? ""
            if !keepText { text = savedText }
            error = nil
            loaded = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    func revert() {
        conflict = false
        Task { await load(keepText: false) }
    }

    func save() {
        guard dirty, !saving, let expected = hash else { return }
        saving = true
        let content = text
        Task {
            defer { saving = false }
            do {
                let saved = try await app.withFreshCode { [client, workspaceId, repoId, path, worktree] in
                    try await client.saveWorkspaceFile(id: workspaceId, repo: repoId, path: path,
                                                       content: content, expectedHash: expected, worktree: worktree)
                }
                if let saved {
                    hash = saved
                    savedText = content
                    conflict = false
                    error = nil
                } else {
                    conflict = true
                }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// Saves over a change made on disk since the file was opened.
    func overwrite() {
        Task {
            await load(keepText: true)
            conflict = false
            save()
        }
    }
}
