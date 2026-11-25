import Foundation
import Observation
import YarvisClient

/// One open review workspace: the workspace row, a `ReviewPrModel` per PR,
/// the tab layout, clone progress, and the actions the header and nav take.
@MainActor @Observable
final class ReviewWorkspaceModel {
    unowned let page: ReviewModel
    let client: YarvisClient
    let id: String

    private(set) var workspace: ReviewWorkspace?
    /// The last failed action or read, shown in the header's error bar.
    var error: String?
    /// One per PR, by PR id, kept while the PR stays in the workspace.
    private(set) var prs: [String: ReviewPrModel] = [:]
    /// The PR bar's state per PR, kept with the PR so a banner survives a tab switch.
    private(set) var bars: [String: ReviewPrBarModel] = [:]
    /// The workspace's Ask Claude session.
    private(set) var claude: ReviewClaudeModel!
    /// The agent tabs' models, kept while the workspace is open.
    let tabModels = ReviewTabModelStore()

    /// Split or unified, for every diff-like tab. Saved app-wide.
    var diffMode: ReviewDiffMode = ReviewDiffMode(rawValue: UserDefaults.standard.string(forKey: "review.diffMode") ?? "")
        ?? .split {
        didSet { UserDefaults.standard.set(diffMode.rawValue, forKey: "review.diffMode") }
    }

    /// The nav's share of the width. Saved app-wide by `saveNavRatio()` once a drag ends.
    var navRatio: Double = ReviewWorkspaceModel.savedNavRatio()
    static let minNavRatio = 0.12
    private static let navRatioKey = "review.navRatio"

    func saveNavRatio() {
        UserDefaults.standard.set(navRatio, forKey: Self.navRatioKey)
    }

    private static func savedNavRatio() -> Double {
        let saved = UserDefaults.standard.double(forKey: navRatioKey)
        return saved >= minNavRatio && saved < 0.8 ? saved : 0.2
    }

    /// The open tabs, saved per workspace on every change but a divider drag,
    /// which saves when it ends.
    private(set) var layout: ReviewTabLayout {
        didSet { if layout != oldValue && !draggingRatio { saveLayout() } }
    }
    private var draggingRatio = false
    /// A focus asked for before the PR was in the workspace.
    private var pendingFocus: (prId: String, tab: ReviewTabSpec.Kind)?
    /// The PR whose setup prompt is open.
    var setupPrId: String?

    private var progressTasks: [String: Task<Void, Never>] = [:]
    private var pollTask: Task<Void, Never>?
    private var readGeneration = 0
    private(set) var stopped = false

    /// Stack-layer ticks the reviewer changed, by ref key; the rest follow `pickedByDefault`.
    var stackPicks: [String: Bool] = [:]
    private(set) var addingLayers = false

    private let serverDefaults: ServerDefaults

    init(page: ReviewModel, client: YarvisClient, id: String) {
        self.page = page
        self.client = client
        self.id = id
        serverDefaults = ServerDefaults(server: client.baseURL)
        layout = ReviewTabLayout.parse(serverDefaults.data(Self.layoutKey(id)))
        claude = ReviewClaudeModel(workspace: self)
        reload()
        // Records the open, which orders the list; a failure only leaves the order as it was.
        Task { [client] in _ = try? await client.openReviewWorkspace(id: id) }
        startPolling()
    }

    func stop() {
        stopped = true
        pollTask?.cancel()
        progressTasks.values.forEach { $0.cancel() }
        progressTasks = [:]
        bars.values.forEach { $0.stop() }
        claude.stop()
        tabModels.stop()
    }

    func handle(_ event: ServerEvent) {
        claude.handle(event)
    }

    // MARK: Reading

    func reload() {
        Task { await read() }
    }

    func read() async {
        readGeneration += 1
        let generation = readGeneration
        do {
            let ws = try await client.reviewWorkspace(id: id)
            guard generation == readGeneration, !stopped else { return }
            apply(ws)
        } catch YarvisError.http(status: 404, _, _) {
            guard generation == readGeneration, !stopped else { return }
            page.closeWorkspace(forget: true)
        } catch {
            guard generation == readGeneration, !stopped else { return }
            self.error = error.localizedDescription
        }
    }

    /// Faster while a clone, checkout or setup runs, and only while the page shows.
    private func startPolling() {
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard let self, !Task.isCancelled, !self.stopped else { return }
                if let ws = self.workspace, isSettling(ws), self.page.pageVisible { await self.read() }
            }
        }
    }

    private func apply(_ ws: ReviewWorkspace) {
        workspace = ws
        var next: [String: ReviewPrModel] = [:]
        var nextBars: [String: ReviewPrBarModel] = [:]
        for row in ws.prs {
            if let model = prs[row.id] {
                model.update(row)
                next[row.id] = model
            } else {
                next[row.id] = ReviewPrModel(client: client, server: client.baseURL, workspaceId: id, pr: row)
            }
            nextBars[row.id] = bars[row.id] ?? ReviewPrBarModel(workspace: self, prId: row.id)
        }
        for (prId, bar) in bars where nextBars[prId] == nil { bar.stop() }
        prs = next
        bars = nextBars
        followProgress(ws.prs)
        let ordered = orderedPrs.map(\.prId)
        let hadClaude = layout.find("claude") != nil
        layout = layout.pruning(keeping: ordered)
        if hadClaude && layout.find("claude") == nil { claude.detach() }
        if let focus = pendingFocus, prs[focus.prId] != nil {
            pendingFocus = nil
            openTab(ReviewTabSpec(kind: focus.tab, prId: focus.prId))
        }
        if layout.isEmpty, let first = ordered.first {
            openTab(ReviewTabSpec(kind: .description, prId: first))
        }
        claude.workspaceChanged()
    }

    /// One progress stream per PR still cloning, so the nav says what the
    /// clone is doing. Its end reads the workspace again.
    private func followProgress(_ rows: [ReviewWorkspacePr]) {
        let cloning = Set(rows.filter { $0.status == "pending" || $0.status == "cloning" }.map(\.id))
        for (prId, task) in progressTasks where !cloning.contains(prId) {
            task.cancel()
            progressTasks[prId] = nil
            prs[prId]?.cloneLog = nil
        }
        for prId in cloning where progressTasks[prId] == nil {
            progressTasks[prId] = Task { [weak self, client, id] in
                // A clone logs many lines a second; the nav shows one, a few times a second.
                var shown = ContinuousClock.now - .seconds(1)
                do {
                    for try await event in try client.reviewPrProgress(workspaceId: id, prId: prId) {
                        guard let self, !Task.isCancelled else { return }
                        switch event {
                        case .log(let line):
                            guard ContinuousClock.now - shown >= .milliseconds(250) else { continue }
                            shown = .now
                            self.prs[prId]?.cloneLog = line
                        case .done: await self.read()
                        case .start: break
                        }
                    }
                } catch {}
                guard let self, !Task.isCancelled else { return }
                self.progressTasks[prId] = nil
            }
        }
    }

    /// The workspace's PRs in nav order.
    var orderedPrs: [ReviewPrModel] {
        prs.values.sorted { $0.pr.position < $1.pr.position }
    }

    /// The PR of the focused group's tab, else the first PR.
    var frontPrId: String? {
        if let active = layout.activeTab, prs[active.prId] != nil, active.kind != .claude { return active.prId }
        return orderedPrs.first?.prId
    }

    func ownerLabel(_ prId: String) -> String? {
        guard prs.count > 1, let pr = prs[prId]?.pr else { return nil }
        return tabOwnerLabel(pr, among: orderedPrs.map(\.pr))
    }

    // MARK: Tabs

    static func layoutKey(_ id: String) -> String { "review.tabs.\(id)" }

    /// Opens `tab` on `prId` once the PR is in the workspace.
    func focus(prId: String, tab: ReviewTabSpec.Kind) {
        if prs[prId] != nil {
            openTab(ReviewTabSpec(kind: tab, prId: prId))
        } else {
            pendingFocus = (prId, tab)
            reload()
        }
    }

    /// Opens a tab in the focused group, or brings it forward where it is open.
    func openTab(_ spec: ReviewTabSpec, group: Int? = nil) {
        layout = layout.opening(spec, group: group)
    }

    func focusTab(_ id: String) { layout = layout.focusing(id) }
    func closeTab(_ id: String) {
        layout = layout.closing(id)
        // The session keeps running on the server; only this Mac's view of it goes.
        if id == "claude" { claude.detach() }
    }
    func cycleTab(forward: Bool) { layout = layout.cycling(forward: forward) }
    func moveActiveToOtherGroup() { layout = layout.movingActiveToOtherGroup() }
    func focusGroup(_ group: Int) { layout = layout.focusingGroup(group) }

    func moveTab(_ id: String, toGroup group: Int, before beforeId: String? = nil) {
        layout = layout.moving(id, toGroup: group, before: beforeId)
    }

    func reorderTab(_ id: String, inGroup group: Int, onto targetId: String, after: Bool) {
        layout = layout.reordering(inGroup: group, id, onto: targetId, after: after)
    }

    func setGroupRatio(_ ratio: Double) {
        draggingRatio = true
        layout.ratio = min(max(ratio, ReviewTabLayout.minRatio), 1 - ReviewTabLayout.minRatio)
    }

    func endGroupRatioDrag() {
        draggingRatio = false
        saveLayout()
    }

    private func saveLayout() {
        serverDefaults.set(layout.serialized(), Self.layoutKey(id))
    }

    /// Option-J / Option-K: the next or previous changed file of the front PR, as a diff.
    func stepFile(forward: Bool) {
        guard let prId = frontPrId, let pr = prs[prId] else { return }
        pr.loadChangedFiles()
        let active = layout.activeTab
        let current = active?.kind == .diff && active?.prId == prId ? active?.path : nil
        guard let path = adjacentPath(pr.fileOrder, current: current, forward: forward) else { return }
        openTab(.diff(prId: prId, path: path))
    }

    /// Opens the setup prompt for a PR.
    func openSetup(prId: String) {
        setupPrId = prId
    }

    /// Drops what this Mac saved for an archived or missing workspace.
    static func forgetSaved(id: String, server: URL) {
        ServerDefaults(server: server).set(nil, layoutKey(id))
    }

    // MARK: Header actions

    /// Runs a write, showing its failure in the error bar.
    func attempt(_ action: @escaping () async throws -> Void) async {
        do {
            try await action()
            if !stopped { error = nil }
        } catch {
            if !stopped { self.error = error.localizedDescription }
        }
    }

    func rename(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != workspace?.name else { return }
        Task {
            await attempt { [client, id] in
                let ws = try await client.renameReviewWorkspace(id: id, name: trimmed)
                guard !self.stopped else { return }
                self.workspace?.name = ws.name
                await self.page.refreshList()
            }
        }
    }

    /// Adds the PR, or opens its description when the workspace holds it already.
    func addPr(_ summary: PrSummary) async throws {
        if let held = orderedPrs.first(where: { $0.ref.key == summary.ref.key }) {
            openTab(ReviewTabSpec(kind: .description, prId: held.prId))
            return
        }
        let added = try await client.addReviewPr(workspaceId: id, ref: summary.ref)
        pendingFocus = (added.id, .description)
        await read()
    }

    /// Adds stack layers one at a time, collecting failures into one message.
    func addLayers(_ refs: [PrRef]) {
        guard !addingLayers else { return }
        addingLayers = true
        Task {
            var failures: [String] = []
            for ref in refs {
                do {
                    _ = try await client.addReviewPr(workspaceId: id, ref: ref)
                } catch {
                    failures.append("\(prLabel(ref)): \(error.localizedDescription)")
                }
            }
            addingLayers = false
            guard !stopped else { return }
            if let message = stackAddError(failures) { self.error = message }
            await read()
        }
    }

    /// Removes the PR and its checkout; its tabs close once the workspace reads it gone.
    func removePr(_ prId: String) async throws {
        try await client.removeReviewPr(workspaceId: id, prId: prId)
        guard !stopped else { return }
        await read()
    }

    func archive() async throws {
        try await client.archiveReviewWorkspace(id: id)
        guard !stopped else { return }
        page.closeWorkspace(forget: true)
    }

    // MARK: Stack layers

    /// One picker per stack the PRs belong to. Each stack walk is a provider
    /// round trip per layer, so stacks are looked up one at a time and a PR
    /// an earlier stack lists isn't looked up again. A failed lookup ends the
    /// chain: the next PR is usually in the same stack.
    func stackPickers() -> [PrStack] {
        var seen = Set<String>()
        var pickers: [PrStack] = []
        for pr in orderedPrs where !seen.contains(pr.ref.key) {
            guard case let .some(stack) = pr.stack.value else {
                // Deferred: this runs while the nav draws, which mustn't change state.
                if pr.stack.error == nil && !pr.stack.loading { Task { pr.loadStack() } }
                break
            }
            guard let stack else { continue }
            pickers.append(stack)
            seen.formUnion(stack.entries.map(\.ref.key))
        }
        return pickers
    }

    var heldRefKeys: Set<String> { Set(prs.values.map(\.ref.key)) }

    func isPicked(_ entry: StackEntry) -> Bool { stackPicks[entry.ref.key] ?? pickedByDefault(entry) }
}

enum ReviewDiffMode: String, Sendable {
    case split, unified
}

/// What a tab body is given: its PR's shared data and the ways out of the tab.
@MainActor
struct ReviewTabContext {
    let workspace: ReviewWorkspaceModel
    let pr: ReviewPrModel
    /// The tab is the one showing in its group. Hidden tabs stay alive, so
    /// they use this to pause streams, polls and per-draw work.
    let isActive: Bool
    var diffMode: ReviewDiffMode { workspace.diffMode }
    var client: YarvisClient { workspace.client }
    var app: AppModel { workspace.page.app }

    func openTab(_ spec: ReviewTabSpec) { workspace.openTab(spec) }
    func openSetup() { workspace.openSetup(prId: pr.prId) }
}
