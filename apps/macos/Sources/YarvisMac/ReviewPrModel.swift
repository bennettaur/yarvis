import Foundation
import Observation
import YarvisClient

/// One value read from the server, with whether a read is running and why
/// the last one failed. A failed refresh keeps the value already shown.
struct Loaded<Value> {
    var value: Value?
    var loading = false
    var error: String?
    /// Bumped per read, so an older answer that lands last is dropped.
    fileprivate var generation = 0
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

    private(set) var detail = Loaded<PrDetail>()
    private(set) var status = Loaded<PrStatus>()
    private(set) var stack = Loaded<PrStack?>()
    private(set) var changedFiles = Loaded<ReviewChangedFiles>()
    private(set) var tree = Loaded<ReviewTree>()
    private(set) var lastReview = Loaded<LastReview>()
    private(set) var commits = Loaded<PrCommits>()
    private(set) var checklist = Loaded<VerificationChecklist>()
    private(set) var insights = Loaded<[PrInsight]>()

    /// Paths marked viewed. Nil until the first read; toggles wait for it.
    private(set) var viewed: Set<String>?
    var viewedError: String?

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
        changedFiles = Loaded()
        tree = Loaded()
        commits = Loaded()
        lastReview = Loaded()
    }

    // MARK: Reads

    /// Runs `read` into `keyPath` unless a value is there and `force` is false.
    private func load<V: Sendable>(_ keyPath: ReferenceWritableKeyPath<ReviewPrModel, Loaded<V>>, force: Bool,
                                   _ read: @escaping @Sendable (YarvisClient) async throws -> V) {
        if !force && (self[keyPath: keyPath].value != nil || self[keyPath: keyPath].loading) { return }
        self[keyPath: keyPath].generation += 1
        let generation = self[keyPath: keyPath].generation
        self[keyPath: keyPath].loading = true
        Task { [client] in
            do {
                let value = try await read(client)
                guard self[keyPath: keyPath].generation == generation else { return }
                self[keyPath: keyPath].value = value
                self[keyPath: keyPath].error = nil
            } catch {
                guard self[keyPath: keyPath].generation == generation else { return }
                self[keyPath: keyPath].error = error.localizedDescription
            }
            self[keyPath: keyPath].loading = false
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

    /// After a comment, review or mark: the last review moved, and the
    /// commits it marks as new with it.
    func invalidateLastReview() {
        loadLastReview(force: true)
        loadCommits(force: true)
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
    private var viewedKey: String { "review.viewed.\(ref.key)" }

    func loadViewed() {
        if case .azure = ref {
            let saved = serverDefaults.data(viewedKey).flatMap { try? JSONDecoder().decode([String].self, from: $0) }
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
    /// path back and says so; the rest stay marked.
    func setViewed(_ paths: [String], _ isViewed: Bool) {
        guard var current = viewed else { return }
        let changing = paths.filter { current.contains($0) != isViewed }
        guard !changing.isEmpty else { return }
        for p in changing { if isViewed { current.insert(p) } else { current.remove(p) } }
        viewed = current
        if case .azure = ref {
            serverDefaults.set(try? JSONEncoder().encode(current.sorted()), viewedKey)
            return
        }
        let ref = ref
        Task {
            var failed: [String] = []
            for p in changing {
                do {
                    try await client.setFileViewed(ref, path: p, viewed: isViewed)
                } catch {
                    failed.append(p)
                }
            }
            guard !failed.isEmpty else { return }
            for p in failed { if isViewed { viewed?.remove(p) } else { viewed?.insert(p) } }
            viewedError = failed.count == 1
                ? "Could not mark \(failed[0]) \(isViewed ? "viewed" : "unviewed")"
                : "Could not mark \(failed.count) files \(isViewed ? "viewed" : "unviewed")"
        }
    }
}
