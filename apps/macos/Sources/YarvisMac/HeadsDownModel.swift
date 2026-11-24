import Foundation
import Observation
import YarvisClient

/// The Heads down page: what heads-down mode is working on, what it needs
/// from the user, what it has done, and a place to tell it things. Also owns
/// the question dialog and the merge pop-ups, which show over any page.
@MainActor @Observable
final class HeadsDownModel {
    private unowned let app: AppModel
    let client: YarvisClient

    // Nil until their first load, so an empty list isn't shown while it loads.
    private(set) var state: HeadsDownState?
    private(set) var questions: [HeadsDownQuestion]?
    private(set) var streams: [WorkStream]?
    private(set) var passes: [HeadsDownPass]?
    private(set) var messages: [HeadsDownMessage]?
    private(set) var autoApprovals: [HeadsDownQuestion]?
    private(set) var routines: HeadsDownRoutines?
    private(set) var routinesError: String?
    private(set) var config: HeadsDownConfig?
    private(set) var allowedTools: [HeadsDownAllowedTool]?
    /// The chat catalogue, for the model picker. Nil until it loads.
    private(set) var providers: [ProviderInfo]?
    /// Why the main lists last failed to load.
    private(set) var error: String?
    var refreshing: Bool { loadsInFlight > 0 }
    private var loadsInFlight = 0
    /// Bumped per reload, so an older answer that lands last is dropped.
    private var generation = 0
    private var loaded = false

    /// The pass in flight, from the live stream. Only followed while the page is on screen.
    private(set) var live = HeadsDownLive()
    var settingsOpen = false

    init(app: AppModel, client: YarvisClient) {
        self.app = app
        self.client = client
    }

    func stop() {
        questionDialog = nil
    }

    func handle(_ event: ServerEvent) {
        if event.kind == "sidecar.started", loaded { reload() }
    }

    func resync() {
        if loaded { reload() }
        if questionDialog != nil { Task { await loadDialog() } }
    }

    var workspaceNames: [String: String] {
        Dictionary((app.workspaces?.workspaces ?? []).map { ($0.id.lowercased(), $0.name) },
                   uniquingKeysWith: { a, _ in a })
    }

    // MARK: Loading

    /// Reads every list the page shows.
    func reload() {
        generation += 1
        let generation = generation
        loaded = true
        loadsInFlight += 1
        let client = client
        Task {
            defer { loadsInFlight -= 1 }
            async let state = attempt { try await client.headsDownState() }
            async let questions = attempt { try await client.headsDownQuestions() }
            async let streams = attempt { try await client.workStreams() }
            async let passes = attempt { try await client.headsDownPasses() }
            async let messages = attempt { try await client.headsDownMessages() }
            async let approvals = attempt { try await client.headsDownAutoApprovals() }
            async let routines = attempt { try await client.headsDownRoutines() }
            async let config = attempt { try await client.headsDownConfig() }
            async let tools = attempt { try await client.headsDownAllowedTools() }
            let results = await (state, questions, streams, passes, messages, approvals, routines, config, tools)
            guard generation == self.generation else { return }
            var failure: Error?
            func take<T>(_ r: Result<T, Error>, into slot: inout T?) {
                switch r {
                case .success(let v): slot = v
                case .failure(let e): failure = failure ?? e
                }
            }
            take(results.0, into: &self.state)
            take(results.1, into: &self.questions)
            take(results.2, into: &self.streams)
            take(results.3, into: &self.passes)
            take(results.4, into: &self.messages)
            error = failure?.localizedDescription
            if case .success(let v) = results.5 { autoApprovals = v }
            switch results.6 {
            case .success(let v):
                self.routines = v
                routinesError = nil
            case .failure(let e):
                routinesError = e.localizedDescription
            }
            if case .success(let v) = results.7 { self.config = v }
            if case .success(let v) = results.8 { allowedTools = v }
        }
    }

    func loadProviders() async {
        guard providers == nil else { return }
        do {
            providers = try await client.chatProviders().filter { !$0.models.isEmpty }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Follows the live stream while the page is on screen, re-reading the
    /// lists on each connect since the stream doesn't replay what it missed.
    func follow() async {
        while !Task.isCancelled {
            live.reset()
            reload()
            do {
                for try await event in try client.headsDownStream() where live.apply(event) {
                    reload()
                }
            } catch YarvisError.unauthorized {
                return
            } catch {
                // Dropped: reconnect below.
            }
            live.reset()
            try? await Task.sleep(for: .seconds(5))
        }
    }

    // MARK: Actions

    /// Runs a change, then reads the lists again. Throws for the caller to show.
    func perform(_ action: @Sendable (YarvisClient) async throws -> Void) async throws {
        try await action(client)
        reload()
    }

    func passMessages(_ id: String) async throws -> [HeadsDownPassMessage] {
        try await client.headsDownPassMessages(id: id)
    }

    func reloadRoutines() async throws {
        routines = try await client.reloadHeadsDownRoutines()
        routinesError = nil
    }

    func openWorkspace(_ id: String) {
        app.openWorkspace(id: id)
    }

    /// A link in a pass's notes or a question: `yarvis://` places open in the
    /// app (anything it doesn't know stays inert), web links in the browser.
    func openLink(_ url: URL) {
        if url.scheme == "yarvis" {
            app.open(link: url)
        } else {
            openWebLink(url)
        }
    }

    // MARK: The question dialog

    /// Open over any page from a heads-down item in the bell. It starts with
    /// that item's question, walks through every other open one, and closes
    /// once none are left.
    private(set) var questionDialog: QuestionDialogState?
    private var dialogGeneration = 0

    struct QuestionDialogState: Equatable {
        var item: AttentionItem
        /// Nil while the first load runs.
        var questions: [HeadsDownQuestion]?
        var error: String?
        /// While the list reloads after an answer, the answered card is still on screen.
        var reloading = false
    }

    func openQuestions(from item: AttentionItem) {
        dialogGeneration += 1
        questionDialog = QuestionDialogState(item: item)
        Task { await loadDialog() }
    }

    func closeQuestions() {
        dialogGeneration += 1
        questionDialog = nil
    }

    func openPageFromDialog() {
        closeQuestions()
        app.section = .headsDown
    }

    private enum DialogLoad { case loaded, failed, replaced }

    @discardableResult
    private func loadDialog() async -> DialogLoad {
        dialogGeneration += 1
        let generation = dialogGeneration
        guard let item = questionDialog?.item else { return .replaced }
        do {
            let open = try await client.headsDownQuestions()
            guard generation == dialogGeneration else { return .replaced }
            questionDialog?.questions = orderQuestions(open, first: headsDownQuestionId(item))
            questionDialog?.error = nil
            return .loaded
        } catch {
            guard generation == dialogGeneration else { return .replaced }
            questionDialog?.error = error.localizedDescription
            return .failed
        }
    }

    /// The front question was answered or dismissed: show the next, or close.
    func dialogAnswered() {
        questionDialog?.reloading = true
        if loaded { reload() }
        Task {
            let result = await loadDialog()
            guard result != .replaced, questionDialog != nil else { return }
            questionDialog?.reloading = false
            if result == .failed {
                // At least stop offering the question just answered.
                if questionDialog?.questions?.isEmpty == false { questionDialog?.questions?.removeFirst() }
            } else if questionDialog?.questions?.isEmpty == true {
                closeQuestions()
            }
        }
    }

    // MARK: Merge pop-ups

    /// Held merges put away with Escape this session; they still wait under Needs you.
    private(set) var deferredReviews: Set<String> = []

    func deferReview(_ item: AttentionItem) {
        deferredReviews.insert(item.id)
    }

    /// Merges held back for open review feedback, waiting on the user.
    var mergeReviews: [(item: AttentionItem, review: MergeReview)] {
        (app.attention?.items ?? []).compactMap { item in
            guard !deferredReviews.contains(item.id), let review = mergeReview(of: item) else { return nil }
            return (item, review)
        }
    }

    /// Merges heads-down mode made, newest first.
    var mergeAnnouncements: [(item: AttentionItem, merge: MergeAnnouncement)] {
        (app.attention?.items ?? []).compactMap { item in
            mergeAnnouncement(of: item).map { (item, $0) }
        }
    }

    /// Answers a held merge. Review denies it and opens the PR, so the user
    /// can look at the feedback themselves.
    func answer(_ review: MergeReview, approve: Bool) async throws {
        try await client.answerHeadsDownQuestion(id: review.questionId, choice: approve ? "approve" : "deny")
        app.attention?.reload()
        if loaded { reload() }
        if !approve { app.attention?.navigate(review.reviewTarget) }
    }

    func openMerge(_ item: AttentionItem) {
        app.attention?.open(item)
    }

    func dismissMerge(_ item: AttentionItem) {
        app.attention?.dismiss(item)
    }
}

private func attempt<T: Sendable>(_ body: @Sendable () async throws -> T) async -> Result<T, Error> {
    do {
        return .success(try await body())
    } catch {
        return .failure(error)
    }
}
