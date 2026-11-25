import Foundation
import Observation
import YarvisClient

/// One value read from the server, with whether a read is running and why
/// the last one failed. A failed refresh keeps the value already shown.
struct Loaded<Value> {
    var value: Value?
    /// True while the first read runs. A refresh behind a value already
    /// shown leaves it false, so a poll doesn't flicker a spinner.
    var loading = false
    var error: String?
    /// Bumped per read, so an older answer that lands last is dropped.
    fileprivate var generation = 0

    /// Forgets the value. The generation keeps counting, so a read started
    /// before the reset can't land after it.
    fileprivate mutating func reset() {
        value = nil
        loading = false
        error = nil
        generation += 1
    }
}

/// What every tab of one PR reads: its provider detail, the checkout's
/// changed files and tree, the viewed set, the last review, the commits,
/// the verification checklist and the line insights. Tabs read these here
/// rather than each fetching its own copy, so a write in one tab shows in
/// the others.
@MainActor @Observable
final class ReviewPrModel {
    private let client: YarvisClient
    private let serverDefaults: ServerDefaults
    let workspaceId: String
    /// The PR row as the workspace last read it; the workspace model replaces it.
    var pr: ReviewWorkspacePr

    private(set) var detail = Loaded<PrDetail>() {
        didSet { if detail.value != oldValue.value { detailChanged() } }
    }
    private(set) var status = Loaded<PrStatus>()
    private(set) var stack = Loaded<PrStack?>()
    private(set) var changedFiles = Loaded<ReviewChangedFiles>() {
        didSet { if changedFiles.value != oldValue.value { changedFilesChanged() } }
    }
    private(set) var tree = Loaded<ReviewTree>() {
        didSet { if tree.value != oldValue.value { allFilesTree = buildFileTree(tree.value?.paths ?? []) } }
    }
    private(set) var lastReview = Loaded<LastReview>() {
        didSet {
            // The commits marked new are counted from the last review, so
            // they follow it; reloading before it lands would use the old mark.
            if lastReview.value != oldValue.value && (commits.value != nil || commits.loading) {
                loadCommits(force: true)
            }
        }
    }
    private(set) var commits = Loaded<PrCommits>() {
        didSet { if commits.value != oldValue.value { newCommitCount = commits.value?.commits.filter(\.isNew).count ?? 0 } }
    }
    private(set) var checklist = Loaded<VerificationChecklist>() {
        didSet {
            guard checklist.value?.report?.mustRead != oldValue.value?.report?.mustRead else { return }
            let list = checklist.value?.report?.mustRead ?? []
            mustReadByPath = Dictionary(list.map { ($0.path, $0) }, uniquingKeysWith: { a, _ in a })
        }
    }
    private(set) var insights = Loaded<[PrInsight]>()

    // Worked out once per answer rather than on every draw.
    /// The changed files as the nav's tree.
    private(set) var fileTree: [FileTreeNode] = []
    /// The changed files in the tree's order, for next and previous file.
    private(set) var fileOrder: [String] = []
    private(set) var changedByPath: [String: ReviewChangedFile] = [:]
    /// Every file at the head as a tree, for the nav's All files.
    private(set) var allFilesTree: [FileTreeNode] = []
    /// Comments per path, replies and outdated threads included.
    private(set) var commentCounts: [String: Int] = [:]
    /// Paths with at least one unresolved thread.
    private(set) var openThreadPaths: Set<String> = []
    private(set) var openThreadCount = 0
    private(set) var mustReadByPath: [String: VerificationMustRead] = [:]
    private(set) var newCommitCount = 0

    /// The clone's latest log line while it runs, for the nav's status line.
    var cloneLog: String?

    /// Paths marked viewed. Nil until the first read; toggles wait for it.
    private(set) var viewed: Set<String>?
    var viewedError: String?
    private var viewedIntents = ViewedIntents()

    init(client: YarvisClient, server: URL, workspaceId: String, pr: ReviewWorkspacePr) {
        self.client = client
        serverDefaults = ServerDefaults(server: server)
        self.workspaceId = workspaceId
        self.pr = pr
    }

    var ref: PrRef { pr.ref }
    var prId: String { pr.id }

    /// Takes a fresher row. A new head or merge-base drops what was read at the old one.
    func update(_ row: ReviewWorkspacePr) {
        let moved = row.headSha != pr.headSha || row.mergeBaseSha != pr.mergeBaseSha
        pr = row
        guard moved else { return }
        changedFiles.reset()
        tree.reset()
        commits.reset()
        lastReview.reset()
    }

    private func detailChanged() {
        let threads = detail.value?.reviewThreads ?? []
        commentCounts = navCommentCounts(threads)
        openThreadPaths = navOpenThreadPaths(threads)
        openThreadCount = threads.filter { !$0.isResolved }.count
    }

    private func changedFilesChanged() {
        let files = changedFiles.value?.files ?? []
        fileTree = buildFileTree(files.map(\.path))
        fileOrder = changedFileOrder(files)
        changedByPath = Dictionary(files.map { ($0.path, $0) }, uniquingKeysWith: { a, _ in a })
    }

    // MARK: Reads

    /// Runs `read` into `keyPath` unless a value is there and `force` is false.
    /// An answer equal to what is shown changes nothing, so a poll that
    /// finds nothing new doesn't redraw the tabs reading it.
    private func load<V: Sendable & Equatable>(_ keyPath: ReferenceWritableKeyPath<ReviewPrModel, Loaded<V>>,
                                               force: Bool,
                                               _ read: @escaping @Sendable (YarvisClient) async throws -> V) {
        if !force && (self[keyPath: keyPath].value != nil || self[keyPath: keyPath].loading) { return }
        self[keyPath: keyPath].generation += 1
        let generation = self[keyPath: keyPath].generation
        if self[keyPath: keyPath].value == nil { self[keyPath: keyPath].loading = true }
        Task { [client] in
            var next = self[keyPath: keyPath]
            do {
                let value = try await read(client)
                guard self[keyPath: keyPath].generation == generation else { return }
                next = self[keyPath: keyPath]
                if next.value != value { next.value = value }
                next.error = nil
            } catch {
                guard self[keyPath: keyPath].generation == generation else { return }
                next = self[keyPath: keyPath]
                next.error = error.localizedDescription
            }
            next.loading = false
            if next.value != self[keyPath: keyPath].value || next.error != self[keyPath: keyPath].error
                || next.loading != self[keyPath: keyPath].loading {
                self[keyPath: keyPath] = next
            }
        }
    }

    func loadDetail(force: Bool = false) {
        let ref = ref
        load(\.detail, force: force) { try await $0.prDetail(ref) }
    }

    func loadStatus(force: Bool = false) {
        let ref = ref
        load(\.status, force: force) { try await $0.prStatus(ref) }
    }

    func loadStack(force: Bool = false) {
        let ref = ref
        load(\.stack, force: force) { try await $0.prStack(ref) }
    }

    /// Needs the PR's commits fetched; does nothing before then.
    func loadChangedFiles(force: Bool = false) {
        guard pr.headSha != nil else { return }
        let (ws, id) = (workspaceId, prId)
        load(\.changedFiles, force: force) { try await $0.reviewChangedFiles(workspaceId: ws, prId: id) }
    }

    func loadTree(force: Bool = false) {
        guard pr.headSha != nil else { return }
        let (ws, id) = (workspaceId, prId)
        load(\.tree, force: force) { try await $0.reviewTree(workspaceId: ws, prId: id) }
    }

    func loadLastReview(force: Bool = false) {
        guard pr.headSha != nil else { return }
        let (ws, id) = (workspaceId, prId)
        load(\.lastReview, force: force) { try await $0.lastReview(workspaceId: ws, prId: id) }
    }

    /// The commits, with those after the last review marked new.
    func loadCommits(force: Bool = false) {
        guard pr.headSha != nil else { return }
        let (ws, id) = (workspaceId, prId)
        let mark = lastReview.value
        let from = mark?.shaExists == false ? nil : mark?.mark?.headSha
        load(\.commits, force: force) { try await $0.reviewCommits(workspaceId: ws, prId: id, from: from) }
    }

    func loadChecklist(force: Bool = false) {
        let (ws, id) = (workspaceId, prId)
        load(\.checklist, force: force) { try await $0.verificationChecklist(workspaceId: ws, prId: id) }
    }

    func loadInsights(force: Bool = false) {
        let ref = ref
        load(\.insights, force: force) { try await $0.prInsights(ref) }
    }

    /// After a comment, review or mark: the last review moved. The commits
    /// it marks as new reload once the new mark lands.
    func invalidateLastReview() {
        loadLastReview(force: true)
    }

    /// The "↻" button: everything read from the provider again.
    func refreshProvider() {
        loadDetail(force: true)
        loadStatus(force: true)
        loadStack(force: true)
    }

    /// Replaces the insights after a local change, such as an answer arriving.
    func setInsights(_ list: [PrInsight]) {
        insights.generation += 1
        insights.value = list
        insights.loading = false
    }

    // MARK: Viewed files

    /// GitHub keeps the viewed set on the PR; Azure has none, so this Mac
    /// keeps it per server.
    func loadViewed() {
        if case .azure = ref {
            let saved = serverDefaults.data(azureViewedKey(ref)).flatMap { try? JSONDecoder().decode([String].self, from: $0) }
            viewed = Set(saved ?? [])
            return
        }
        let ref = ref
        Task {
            do {
                viewed = Set(try await client.viewedFiles(ref))
                viewedError = nil
            } catch {
                viewedError = error.localizedDescription
            }
        }
    }

    func setViewed(_ path: String, _ isViewed: Bool) {
        setViewed([path], isViewed)
    }

    /// Marks each path, one request per path on GitHub. A failure puts that
    /// path back and says so, unless it was marked again since; the rest
    /// stay marked. Paths already in that state aren't written.
    func setViewed(_ paths: [String], _ isViewed: Bool) {
        guard let current = viewed else { return }
        let changing = viewedChanges(current, paths: paths, viewed: isViewed)
        guard !changing.isEmpty else { return }
        viewed = applyingViewed(current, paths: changing, viewed: isViewed)
        if case .azure = ref {
            serverDefaults.set(try? JSONEncoder().encode((viewed ?? []).sorted()), azureViewedKey(ref))
            return
        }
        let token = viewedIntents.record(changing)
        let ref = ref
        Task { [client] in
            let failed = await markManyViewed(client, ref, paths: changing, viewed: isViewed)
            guard !failed.isEmpty, let now = viewed else { return }
            viewed = viewedIntents.rollingBack(now, failed: failed, viewed: isViewed, token: token)
            viewedError = viewedFailureMessage(failed, viewed: isViewed)
        }
    }
}
