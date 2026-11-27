import Foundation
import Observation
import YarvisClient

/// The Heads down page's tabs.
enum HeadsDownTab: String, CaseIterable, Identifiable {
    case overview, routines, history, settings

    var id: Self { self }

    var label: String {
        switch self {
        case .overview: return "Overview"
        case .routines: return "Routines"
        case .history: return "History"
        case .settings: return "Settings"
        }
    }
}

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
    private(set) var settingsError: String?
    private(set) var refreshing = false
    /// A reload was asked for while one ran, so one more runs after it.
    @ObservationIgnored private var reloadAgain = false
    /// True while the page is on screen and following the live stream.
    @ObservationIgnored private var following = false

    /// A pass is running now. Flips only when that changes, so the header
    /// doesn't redraw on every streamed token.
    private(set) var working = false
    /// The pass in flight; only the live pass view reads it.
    private(set) var livePass: LivePass?
    /// The live pass's text, parsed as it streams.
    private(set) var liveBlocks: [MarkdownBlock] = []
    @ObservationIgnored private var live = HeadsDownLive()
    @ObservationIgnored private var markdown = MarkdownStream()
    /// The page's tab. Kept here so coming back to the page shows the same one.
    var tab: HeadsDownTab = .overview

    init(app: AppModel, client: YarvisClient) {
        self.app = app
        self.client = client
    }

    func stop() {
        closeQuestions()
    }

    /// The sidecar restarted. The page reads again only while it's on screen;
    /// coming back to it reads everything anyway.
    func handle(_ event: ServerEvent) {
        if event.kind == "sidecar.started", following { reload() }
    }

    func resync() {
        if following { reload() }
        if questionFlow != nil { loadDialog() }
    }

    var workspaceNames: [String: String] {
        Dictionary((app.workspaces?.workspaces ?? []).map { ($0.id.lowercased(), $0.name) },
                   uniquingKeysWith: { a, _ in a })
    }

    // MARK: Loading

    /// Reads every list the page shows. Calls that land while a read runs
    /// are folded into one more read after it.
    func reload() {
        guard !refreshing else {
            reloadAgain = true
            return
        }
        refreshing = true
        Task {
            repeat {
                reloadAgain = false
                apply(await HeadsDownLoad.read(client))
            } while reloadAgain
            refreshing = false
        }
    }

    private func apply(_ load: HeadsDownLoad) {
        update(\.state, load.state)
        update(\.questions, load.questions)
        update(\.streams, load.streams)
        update(\.passes, load.passes)
        update(\.messages, load.messages)
        update(\.autoApprovals, load.autoApprovals)
        update(\.routines, load.routines)
        if error != load.failure { error = load.failure }
        if routinesError != load.routinesFailure { routinesError = load.routinesFailure }
    }

    /// Sets a list only when a fresh one came back and differs, so views
    /// showing it don't redraw for an identical read.
    private func update<T: Equatable>(_ key: ReferenceWritableKeyPath<HeadsDownModel, T?>, _ fresh: T?) {
        if let fresh, self[keyPath: key] != fresh { self[keyPath: key] = fresh }
    }

    /// The settings panel's data: the config, the allowed tools and the chat
    /// catalogue. Read when the panel opens and after a settings change.
    func loadSettings() async {
        do {
            async let config = client.headsDownConfig()
            async let tools = client.headsDownAllowedTools()
            update(\.config, try await config)
            update(\.allowedTools, try await tools)
            if providers == nil { providers = try await client.chatProviders().filter { !$0.models.isEmpty } }
            settingsError = nil
        } catch {
            settingsError = error.localizedDescription
        }
    }

    /// Follows the live stream while the page is on screen, reading the lists
    /// again on each connect since the stream doesn't replay what it missed.
    func follow() async {
        following = true
        defer {
            following = false
            live.reset()
            setLive(nil)
        }
        while !Task.isCancelled {
            live.reset()
            setLive(nil)
            reload()
            do {
                for try await event in try client.headsDownStream() {
                    let changed = live.apply(event)
                    setLive(live.pass)
                    if changed { reload() }
                }
            } catch YarvisError.unauthorized {
                return
            } catch {
                // Dropped: reconnect below.
            }
            live.reset()
            setLive(nil)
            try? await Task.sleep(for: .seconds(5))
        }
    }

    private func setLive(_ pass: LivePass?) {
        if pass?.passId != livePass?.passId { markdown = MarkdownStream() }
        if pass?.text != livePass?.text { liveBlocks = pass.map { markdown.update($0.text) } ?? [] }
        if pass != livePass { livePass = pass }
        if (pass != nil) != working { working = pass != nil }
    }

    // MARK: Actions

    /// Runs a change, then reads the lists again. Throws for the caller to show.
    func perform(_ action: @Sendable (YarvisClient) async throws -> Void) async throws {
        try await action(client)
        reload()
    }

    /// A question on the page was answered. Its card may have allowed a tool,
    /// so the Settings tab, when showing, reads its list again too.
    func questionAnswered() {
        reload()
        if tab == .settings { Task { await loadSettings() } }
    }

    /// Runs a settings change, then reads the settings again, and the page's
    /// lists: the header names the model and the routines depend on the per-pass limit.
    func performSetting(_ action: @Sendable (YarvisClient) async throws -> Void) async throws {
        try await action(client)
        await loadSettings()
        reload()
    }

    func passMessages(_ id: String) async throws -> [HeadsDownPassMessage] {
        try await client.headsDownPassMessages(id: id)
    }

    func reloadRoutines() async throws {
        try await changeRoutines { try await $0.reloadHeadsDownRoutines() }
    }

    func createRoutine(_ routine: NewHeadsDownRoutine) async throws {
        try await changeRoutines { try await $0.createHeadsDownRoutine(routine) }
    }

    func setRoutineEnabled(_ name: String, enabled: Bool) async throws {
        try await changeRoutines { try await $0.setHeadsDownRoutineEnabled(name: name, enabled: enabled) }
    }

    func deleteRoutine(_ name: String) async throws {
        try await changeRoutines { try await $0.deleteHeadsDownRoutine(name: name) }
    }

    /// Every routine route answers with the whole list, so it replaces the one shown.
    private func changeRoutines(_ action: @Sendable (YarvisClient) async throws -> HeadsDownRoutines) async throws {
        routines = try await action(client)
        routinesError = nil
    }

    func openWorkspace(_ id: String) {
        app.openWorkspace(id: id)
    }

    /// A link in text a pass or a question wrote. See `headsDownLinkAction`.
    func openLink(_ url: URL) {
        switch headsDownLinkAction(url) {
        case .openInBrowser(let url): openWebLink(url)
        case .openPlace(let url): app.open(link: url)
        case .openArtifact, .ignore: break
        }
    }

    // MARK: The question dialog

    /// Open over any page from a heads-down item in the bell.
    private(set) var questionFlow: HeadsDownQuestionFlow?
    /// Bumped per dialog load and on close, so a late answer for an older
    /// list, or one after the dialog closed, is dropped.
    @ObservationIgnored private var dialogGeneration = 0

    func openQuestions(from item: AttentionItem) {
        questionFlow = HeadsDownQuestionFlow(firstId: headsDownQuestionId(item))
        loadDialog()
    }

    func closeQuestions() {
        dialogGeneration += 1
        questionFlow = nil
    }

    func openPageFromDialog() {
        closeQuestions()
        app.section = .headsDown
    }

    /// The front question was answered or dismissed: show the next, or close.
    func dialogAnswered() {
        questionFlow?.answered()
        if following { reload() }
        loadDialog()
    }

    private func loadDialog() {
        dialogGeneration += 1
        let generation = dialogGeneration
        Task {
            let load: HeadsDownQuestionFlow.Load
            do {
                load = .loaded(try await client.headsDownQuestions())
            } catch {
                load = .failed(error.localizedDescription)
            }
            // A newer load replaced this one and applies its own answer.
            guard generation == dialogGeneration else { return }
            if questionFlow?.apply(load) == true { closeQuestions() }
        }
    }

    // MARK: Merge pop-ups

    /// Held merges put away with Escape this session; they still wait under Needs you.
    private(set) var deferredReviews: Set<String> = []

    func deferReview(_ item: AttentionItem) {
        deferredReviews.insert(item.id)
    }

    var popup: HeadsDownPopup? {
        HeadsDownPopup.choose(items: app.attention?.items ?? [], deferred: deferredReviews,
                              questionsOpen: questionFlow != nil)
    }

    /// Answers a held merge. Review denies it and opens the PR, so the user
    /// can look at the feedback themselves.
    func answer(_ review: MergeReview, approve: Bool) async throws {
        try await client.answerHeadsDownQuestion(id: review.questionId, choice: approve ? "approve" : "deny")
        app.attention?.reload()
        if following { reload() }
        guard !approve else { return }
        if let url = review.reviewURL {
            openWebLink(url)
        } else {
            app.section = .headsDown
        }
    }

    /// Opens what a merge announcement points at. A PR opens on GitHub, since
    /// the app has no PR page of its own and the web UI wouldn't open on it.
    func openMerge(_ item: AttentionItem) {
        guard let url = gitHubPullRequestURL(navTarget: item.navTarget) else {
            app.attention?.open(item)
            return
        }
        openWebLink(url)
        let client = client
        Task {
            try? await client.setAttentionStatus(id: item.id, "read")
            app.attention?.reload()
        }
    }

    func dismissMerge(_ item: AttentionItem) {
        app.attention?.dismiss(item)
    }
}
