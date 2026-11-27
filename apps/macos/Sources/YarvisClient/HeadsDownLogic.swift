import Foundation

// MARK: - The pass in flight

/// What the pass in flight has done so far, built from its streamed events.
public struct LivePass: Sendable, Equatable {
    public var passId: String
    public var activity: [ToolActivity] = []
    /// The latest stretch of reasoning: what it thought before its last call or reply.
    public var thought = ""
    /// Reasoning is still streaming into `thought`; the next stretch replaces it.
    public var isThinking = false
    public var text = ""
    /// The error the turn just ended on.
    public var error: String?
    /// The sidecar said it will try the pass again after `error`.
    public var retrying = false

    public init(passId: String) {
        self.passId = passId
    }

    /// Folds one streamed event into the pass.
    public mutating func apply(_ event: ChatStreamEvent) {
        switch event {
        case .delta(let s):
            clearError()
            text += s
            isThinking = false
        case .reasoning(let s):
            clearError()
            thought = isThinking ? thought + s : s
            isThinking = true
        case .error(let message, _):
            // Whether it tries again is the sidecar's call; it says so with pass-retrying.
            isThinking = false
            error = message
            retrying = false
        case .toolCall(let call):
            clearError()
            isThinking = false
            activity.append(call)
        case .toolResult(let id, let status, let result, let durationMs):
            guard let i = activity.firstIndex(where: { $0.id == id }) else { return }
            activity[i].status = status
            activity[i].result = result
            activity[i].durationMs = durationMs
        default:
            break
        }
    }

    /// Work has carried on, so the last error and its retry are behind it.
    private mutating func clearError() {
        error = nil
        retrying = false
    }
}

/// The first non-blank line, without reading past it: a thought can run long
/// and is folded on every streamed token.
public func firstLine(of text: String) -> Substring {
    let start = text.drop(while: \.isWhitespace)
    return start.prefix(while: { !$0.isNewline })
}

/// Follows the page's stream: the pass in flight, and whether the lists need reading again.
public struct HeadsDownLive: Sendable, Equatable {
    public private(set) var pass: LivePass?

    public init() {}

    /// Applies one event. True when something the page lists may have changed.
    public mutating func apply(_ event: HeadsDownStreamEvent) -> Bool {
        switch event {
        case .passStarted(let id):
            pass = LivePass(passId: id)
        case .passEvent(let id, let inner):
            if pass?.passId == id { pass?.apply(inner) }
        case .passRetrying(let id):
            if pass?.passId == id { pass?.retrying = true }
        case .passFinished:
            pass = nil
            return true
        case .changed:
            return true
        case .ping, .unknown:
            break
        }
        return false
    }

    /// Forgets the pass in flight. Call it when the stream drops: a pass that
    /// finishes while it is down tells nobody, so the caller reads the lists
    /// again instead.
    public mutating func reset() {
        pass = nil
    }
}

// MARK: - The run header

/// What heads-down mode is doing right now, for the logo in the header.
public enum HeadsDownAgentState: Sendable, Equatable {
    case working, sleeping, off

    public var label: String {
        switch self {
        case .working: return "Heads down is working"
        case .sleeping: return "Heads down is sleeping"
        case .off: return "Heads down is off"
        }
    }

    /// With no next pass scheduled yet, the first one is starting; a paused run sleeps.
    public init(state: HeadsDownState, working: Bool) {
        guard let run = state.run else {
            self = .off
            return
        }
        self = run.pausedAt == nil && (working || state.nextPassAt == nil) ? .working : .sleeping
    }
}

/// The header's line about what happens next.
public enum NextPass: Sendable, Equatable {
    case paused
    case working
    case sleepingUntil(Date)
    case noneBeforeStop
    case starting

    public init(state: HeadsDownState, run: HeadsDownRun, working: Bool) {
        if run.pausedAt != nil {
            self = .paused
        } else if working {
            self = .working
        } else if let next = state.nextPassAt.flatMap(parseISODate) {
            self = .sleepingUntil(next)
        } else if state.lastPass != nil, run.stopAt != nil {
            // The sidecar leaves out a next pass that would come after the stop time.
            self = .noneBeforeStop
        } else {
            self = .starting
        }
    }

    public func text(time: (Date) -> String) -> String {
        switch self {
        case .paused: return "No passes until you resume it. Its streams and questions are kept."
        case .working: return "Working now"
        case .sleepingUntil(let at): return "Sleeping until \(time(at))"
        case .noneBeforeStop: return "No more passes before it stops"
        case .starting: return "Starting its first pass"
        }
    }
}

/// Hour and minute from "HH:MM" (one-digit parts allowed). Nil when malformed or out of range.
public func parseHHMM(_ value: String) -> (hour: Int, minute: Int)? {
    let parts = value.split(separator: ":", omittingEmptySubsequences: false)
    guard parts.count == 2, let hour = Int(parts[0]), let minute = Int(parts[1]),
          (0..<24).contains(hour), (0..<60).contains(minute) else { return nil }
    return (hour, minute)
}

/// The next time the clock reads `hhmm` ("19:00"), as an ISO timestamp:
/// today, or tomorrow once today's has passed. Nil for a malformed time.
/// Tomorrow is a calendar day, so a DST change overnight keeps the wall time.
public func nextOccurrence(_ hhmm: String, now: Date = Date(), calendar: Calendar = .current) -> String? {
    guard let time = parseHHMM(hhmm),
          var at = calendar.date(bySettingHour: time.hour, minute: time.minute, second: 0, of: now)
    else { return nil }
    if at <= now {
        guard let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)),
              let next = calendar.date(bySettingHour: time.hour, minute: time.minute, second: 0, of: tomorrow)
        else { return nil }
        at = next
    }
    return ISO8601DateFormatter().string(from: at)
}

/// "HH:MM" for a time of day, as the stop-time and working-hours fields send it.
public func hhmm(_ date: Date, calendar: Calendar = .current) -> String {
    let c = calendar.dateComponents([.hour, .minute], from: date)
    return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
}

/// A date on `reference`'s day at "HH:MM", for a time picker. Nil when malformed.
public func dateForHHMM(_ value: String, on reference: Date = Date(), calendar: Calendar = .current) -> Date? {
    guard let time = parseHHMM(value) else { return nil }
    return calendar.date(bySettingHour: time.hour, minute: time.minute, second: 0, of: reference)
}

// MARK: - Passes

/// The sleep reasons the sidecar records for a pass cut short on purpose (`headsDown/pass.ts`).
private let stoppedByUser = "stopped by you"
private let reachedStopTime = "reached the stop time"

public func describeSleep(_ pass: HeadsDownPass) -> String? {
    if pass.sleepReason == stoppedByUser { return "Stopped by you" }
    if pass.sleepReason == reachedStopTime { return "Stopped at the stop time" }
    guard let minutes = pass.sleepMinutes else { return nil }
    let reason = pass.sleepReason.map { " (\($0))" } ?? ""
    return "Then slept \(formatMinutes(minutes)) min\(reason)"
}

private func formatMinutes(_ m: Double) -> String {
    m == m.rounded() ? String(Int(m)) : String(m)
}

public func describeCalls(_ pass: HeadsDownPass) -> String? {
    guard let count = pass.callCount, count > 0 else { return nil }
    let calls = pass.failedCalls ?? []
    let noResult = calls.filter { $0.noResult == true }.count
    let failed = calls.count - noResult
    return [
        "\(count) tool call\(count == 1 ? "" : "s")",
        failed > 0 ? "\(failed) failed" : nil,
        noResult > 0 ? "\(noResult) with no result" : nil,
    ].compactMap { $0 }.joined(separator: " · ")
}

/// A failed call's line: its server and name, and why.
public func describeFailedCall(_ call: HeadsDownFailedCall) -> String {
    let name = (call.server.map { "\($0)/" } ?? "") + call.name
    if call.noResult == true { return "\(name): no result" }
    return call.error.map { "\(name): \($0)" } ?? name
}

/// The passes that have finished; the one in flight shows live instead.
public func finishedPasses(_ passes: [HeadsDownPass]) -> [HeadsDownPass] {
    passes.filter { $0.finishedAt != nil }
}

/// The link under the Overview's recent passes to the rest, on History.
public func earlierPassesLabel(_ hidden: Int) -> String {
    "Show \(hidden) earlier pass\(hidden == 1 ? "" : "es")"
}

// MARK: - Work streams

public func workStreamStatusLabel(_ status: String) -> String {
    switch status {
    case "active": return "Moving"
    case "waiting-on-user": return "Waiting on you"
    case "waiting-on-others": return "Waiting on others"
    case "done": return "Done"
    case "dropped": return "Dropped"
    default: return status
    }
}

/// A link's one-line label: what it is and what was last seen of it. A
/// workspace with no title of its own goes by its current name.
public func workStreamLinkLabel(_ link: WorkStreamLink, workspaceNames: [String: String],
                                date: (Date) -> String) -> String {
    let kind: String
    let fallback: String?
    switch link.ref {
    case .ticket(let key, _):
        kind = "ticket"
        fallback = key
    case .workspace(let id):
        kind = "workspace"
        fallback = workspaceNames[id.lowercased()]
    case .pr(let url):
        kind = "pr"
        fallback = url
    case .message(let conversation):
        kind = "message"
        fallback = conversation
    case .reviewRequest(let conversation, let sentAt):
        kind = "review request, sent \(parseISODate(sentAt).map(date) ?? sentAt)"
        fallback = conversation
    case .other(let k):
        kind = k
        fallback = nil
    }
    let name = link.title ?? fallback
    let head = name.map { "\(kind): \($0)" } ?? kind
    return head + (link.state.map { " · \($0)" } ?? "")
}

/// Where clicking a link goes, when it goes anywhere.
public enum WorkStreamLinkTarget: Equatable, Sendable {
    case workspace(String)
    case web(URL)
}

public func workStreamLinkTarget(_ link: WorkStreamLink) -> WorkStreamLinkTarget? {
    switch link.ref {
    case .workspace(let id): return .workspace(id)
    case .pr(let url): return URL(string: url).map(WorkStreamLinkTarget.web)
    case .ticket(_, let url): return url.flatMap(URL.init(string:)).map(WorkStreamLinkTarget.web)
    default: return nil
    }
}

/// True while a stream's "not before" time is still ahead.
public func isSnoozed(_ stream: WorkStream, now: Date = Date()) -> Bool {
    stream.wakeAt.flatMap(parseISODate).map { $0 > now } ?? false
}

// MARK: - Routines

/// `everyMinutes` back in the `30m`/`3h`/`1d` form the file was written in.
public func routineCadence(_ minutes: Int) -> String {
    if minutes > 0, minutes % (24 * 60) == 0 { return "every \(minutes / (24 * 60))d" }
    if minutes > 0, minutes % 60 == 0 { return "every \(minutes / 60)h" }
    return "every \(minutes)m"
}

/// How often it runs, and when it is allowed to: "every 3h, working hours, skip at night".
public func describeCadence(_ r: HeadsDownRoutine) -> String {
    var parts = [r.once ? "once" : routineCadence(r.everyMinutes)]
    if r.workingHoursOnly { parts.append("working hours") }
    if r.nightShift != "run" { parts.append("\(r.nightShift) at night") }
    return parts.joined(separator: ", ")
}

/// Where a routine stands, in words, and the chip's colour.
public struct HeadsDownRoutineStatus: Sendable, Equatable {
    public enum Tone: Sendable, Equatable { case next, due, waiting, off }

    public var label: String
    public var tone: Tone

    public init(_ label: String, _ tone: Tone) {
        self.label = label
        self.tone = tone
    }
}

/// On the next pass, waiting and why, or off and why. `relative` words a
/// time as "in 2 hours". The checks run in the web page's order.
public func routineStatus(_ r: HeadsDownRoutine, relative: (Date) -> String) -> HeadsDownRoutineStatus {
    if !r.enabled {
        if r.switchedTo == false { return .init("Turned off", .off) }
        return r.source == "builtin" ? .init("Off: ships turned off", .off) : .init("Off in your file", .off)
    }
    let due = r.dueAt.flatMap(parseISODate).map(relative)
    if r.nextPass { return .init("Runs on the next pass", .next) }
    if r.queued { return .init("Due, waiting for a free slot", .due) }
    if r.heldBy == "working-hours" { return .init("Waits for working hours", .waiting) }
    if r.heldBy == "night-shift" { return .init("Skipped during night shift", .waiting) }
    if r.heldBy == "retry" { return .init("Didn't finish last time; tries again \(due ?? "")", .due) }
    if r.dueAt != nil { return .init("Due \(due ?? "")", .waiting) }
    return .init("Done", .off)
}

/// The line over the routine list: what the next pass runs, or why none do.
public enum HeadsDownRoutineSummary: Sendable, Equatable {
    /// Routines per pass is 0.
    case noneRun
    case next(line: String, limit: String)

    public init(_ data: HeadsDownRoutines) {
        guard data.maxRoutinesPerPass > 0 else {
            self = .noneRun
            return
        }
        let next = data.routines.filter(\.nextPass).map(\.name)
        self = .next(
            line: next.isEmpty ? "Nothing is due for the next pass." : "Next pass runs: \(next.joined(separator: ", ")).",
            limit: "Up to \(data.maxRoutinesPerPass) per pass, most overdue first.")
    }

    public static let noneRunWarning = "Routines per pass is 0 in Settings, so none of them run."
}

/// The warning that no routine runs while heads-down mode is off. `running`
/// is nil until the state loads, so the warning doesn't flash meanwhile.
public func routinesOffWarning(running: Bool?) -> String? {
    running == false
        ? "Heads-down mode is off, so no routine runs until you start it or tick Always on in Settings."
        : nil
}

/// The add form's comma-separated tool names.
public func parseRoutineTools(_ text: String) -> [String] {
    text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
}

// MARK: - The model line

/// Which model passes run on, and whether that is the saved choice or the default chat model.
public func headsDownModelLine(_ model: HeadsDownPassModel?) -> String {
    guard let model else { return "Model: none available. Add a provider key in Settings." }
    let source = model.source == "saved" ? "set in Settings" : "the default chat model"
    return "Model: \(model.model) (\(model.provider), \(source))"
}

// MARK: - Questions

private let headsDownQuestionPrefix = "heads-down:"

/// The heads-down question an attention item stands for, or nil for any other
/// item. A coding agent's `ask_user` can pick its own session key, so its
/// `question` items never count, however their key reads.
public func headsDownQuestionId(_ item: AttentionItem) -> String? {
    guard item.isHeadsDown, let key = item.sessionKey else { return nil }
    let id = String(key.dropFirst(headsDownQuestionPrefix.count))
    return id.isEmpty ? nil : id
}

/// The dialog's order: the question the user clicked first, the rest oldest first.
public func orderQuestions(_ open: [HeadsDownQuestion], first: String?) -> [HeadsDownQuestion] {
    let oldestFirst = open.sorted { $0.createdAt < $1.createdAt }
    return oldestFirst.filter { $0.id == first } + oldestFirst.filter { $0.id != first }
}

// MARK: - Merges

/// The merge an attention item announces, if it is a heads-down merge alert.
public func mergeAnnouncement(of item: AttentionItem) -> MergeAnnouncement? {
    guard item.source == "system", item.sessionKey?.hasPrefix("heads-down-merge:") == true,
          let merge = item.payload?["headsDownMerge"],
          let risk = merge["risk"]?.stringValue.flatMap(MergeRisk.init(rawValue:))
    else { return nil }
    let number: Int?
    switch merge["number"] {
    case .number(let n)?: number = Int(n)
    case .null?: number = nil
    default: return nil
    }
    return MergeAnnouncement(repo: merge["repo"]?.stringValue ?? "", number: number,
                             title: merge["title"]?.stringValue, risk: risk,
                             why: merge["why"]?.stringValue ?? "")
}

/// The held merge an attention item asks about, if it is one.
public func mergeReview(of item: AttentionItem) -> MergeReview? {
    guard item.source == "system", item.kind == "permission",
          item.sessionKey?.hasPrefix(headsDownQuestionPrefix) == true,
          let review = item.payload?["headsDownMergeReview"],
          let data = try? JSONEncoder().encode(review)
    else { return nil }
    return try? JSONDecoder().decode(MergeReview.self, from: data)
}

extension MergeAnnouncement {
    /// How the alert names the PR.
    public var label: String {
        guard let number else { return "A PR in a workspace" }
        return repo.isEmpty ? "#\(number)" : "\(repo)#\(number)"
    }
}

extension MergeRisk {
    /// The pass's own judgment, so the badge says whose it is.
    public var label: String {
        switch self {
        case .high: return "Heads down rates it high risk"
        case .medium: return "Heads down rates it medium risk"
        case .low: return "Heads down rates it low risk"
        case .unknown: return "Risk not assessed"
        }
    }
}

extension PrFeedback {
    /// Why the PR's workspace did or didn't act on the feedback.
    public var handoffNote: String {
        if handedOff { return "Its workspace was asked to address this feedback, and some is still open." }
        if workspaceId == nil { return "No workspace has this PR, so nobody was asked to address it." }
        if fromOutsiders {
            return "Some of it may be from people outside the repo, so its workspace wasn't asked to act on it."
        }
        return "Its workspace couldn't be asked to address this."
    }

    /// The note under the threads when there are more than the payload carries.
    public var moreThreadsNote: String? {
        let hidden = threadCount - threads.count
        if hidden > 0 { return "\(hidden) more unresolved thread\(hidden > 1 ? "s" : "") on the PR." }
        return threadsTruncated ? "The PR may have more threads that couldn't be loaded." : nil
    }
}

extension MergeReview {
    public var heading: String {
        unchecked != nil
            ? "Heads down wants to merge a PR it couldn't check for feedback"
            : "Heads down wants to merge a PR with open feedback"
    }

    public var label: String {
        prs.first.map { "\($0.repo)#\($0.number)" } ?? "a PR"
    }

    /// The PR Review opens after denying, or nil when there is none it can
    /// name; the Heads down page has the merge then.
    public var reviewURL: URL? {
        prs.first.flatMap { gitHubPullRequestURL(repo: $0.repo, number: $0.number) }
    }
}

/// A GitHub PR's page. Merge feedback is only read for GitHub PRs
/// (`headsDown/mergeFeedback.ts`), so a PR it names lives there.
public func gitHubPullRequestURL(repo: String, number: Int) -> URL? {
    let parts = repo.split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count == 2, parts.allSatisfy({ !$0.isEmpty }),
          let owner = parts.first.map({ encodePathSegment(String($0)) }),
          let name = parts.last.map({ encodePathSegment(String($0)) })
    else { return nil }
    return URL(string: "https://github.com/\(owner)/\(name)/pull/\(number)")
}

/// The page of an attention item's `{"type":"pr"}` target.
public func gitHubPullRequestURL(navTarget: JSONValue?) -> URL? {
    guard navTarget?["type"]?.stringValue == "pr", let owner = navTarget?["owner"]?.stringValue,
          let repo = navTarget?["repo"]?.stringValue, case .number(let n)? = navTarget?["number"]
    else { return nil }
    return gitHubPullRequestURL(repo: "\(owner)/\(repo)", number: Int(n))
}

extension FeedbackThread {
    /// The thread's header line: who, where, and how much followed.
    public var heading: String {
        var s = "Reviewer comment from \(author)"
        if let path { s += " on \(path)" + (line.map { ":\($0)" } ?? "") }
        if outdated { s += " (outdated)" }
        if replies > 0 { s += " · \(replies) repl\(replies == 1 ? "y" : "ies")" }
        return s
    }
}

// MARK: - Workspace mentions in plain text

public enum MentionSegment: Equatable, Sendable {
    case text(String)
    case workspace(id: String, name: String)
}

/// Splits plain text around the ids of known workspaces.
public func splitWorkspaceMentions(_ text: String, names: [String: String]) -> [MentionSegment] {
    let ns = text as NSString
    var segments: [MentionSegment] = []
    var last = 0
    for mention in WorkspaceMentionMatcher.plain.mentions(in: text, names: names) {
        if mention.range.location > last {
            segments.append(.text(ns.substring(with: NSRange(location: last, length: mention.range.location - last))))
        }
        segments.append(.workspace(id: mention.id, name: mention.name))
        last = mention.range.location + mention.range.length
    }
    if last < ns.length { segments.append(.text(ns.substring(from: last))) }
    return segments
}

// MARK: - Links in pass text

/// What a link in agent-written text does. The text can quote what a pass read
/// (an issue, a PR comment), so it doesn't get to move the app around: only
/// workspace links, which the app writes for ids it knows and which only
/// navigate, open in the app. http(s) opens in the browser; anything else is inert.
public func headsDownLinkAction(_ url: URL) -> ChatLinkAction {
    if case .workspace? = YarvisPlace(url) { return .openPlace(url) }
    return chatLinkAction(url, fromUntrusted: true)
}

// MARK: - Pop-ups

/// What heads-down mode shows over the current page. A held merge goes first,
/// since it waits on the user's answer; then merges it made, newest first;
/// then the questions dialog the user opened.
public enum HeadsDownPopup: Identifiable, Equatable, Sendable {
    case review(AttentionItem, MergeReview, remaining: Int)
    case merge(AttentionItem, MergeAnnouncement, remaining: Int)
    case questions

    public var id: String {
        switch self {
        case .review(let item, _, _): return "review:\(item.id)"
        case .merge(let item, _, _): return "merge:\(item.id)"
        case .questions: return "questions"
        }
    }

    /// `items` are the bell's pending items, newest first. Held merges the
    /// user put away (`deferred`) are skipped.
    public static func choose(items: [AttentionItem], deferred: Set<String>, questionsOpen: Bool) -> HeadsDownPopup? {
        let reviews = items.compactMap { item in
            deferred.contains(item.id) ? nil : mergeReview(of: item).map { (item, $0) }
        }
        if let (item, review) = reviews.first { return .review(item, review, remaining: reviews.count - 1) }
        let merges = items.compactMap { item in mergeAnnouncement(of: item).map { (item, $0) } }
        if let (item, merge) = merges.first { return .merge(item, merge, remaining: merges.count - 1) }
        return questionsOpen ? .questions : nil
    }
}

// MARK: - The question dialog

/// The question dialog's list: the clicked question first, then each other
/// open one, until none are left.
public struct HeadsDownQuestionFlow: Equatable, Sendable {
    /// The question the user clicked.
    public let firstId: String?
    /// Nil until the first load lands.
    public private(set) var questions: [HeadsDownQuestion]?
    public private(set) var error: String?
    /// The front question was answered and the list is being read again; its
    /// card stays on screen, inert, until then.
    public private(set) var reloading = false

    public enum Load: Equatable, Sendable {
        case loaded([HeadsDownQuestion])
        case failed(String)
    }

    public init(firstId: String?) {
        self.firstId = firstId
    }

    public var current: HeadsDownQuestion? { questions?.first }

    public mutating func answered() {
        reloading = true
    }

    /// Applies a load. True when an answer left nothing open, so the dialog closes.
    public mutating func apply(_ load: Load) -> Bool {
        let afterAnswer = reloading
        reloading = false
        switch load {
        case .loaded(let open):
            questions = orderQuestions(open, first: firstId)
            error = nil
            return afterAnswer && open.isEmpty
        case .failed(let message):
            error = message
            // At least stop offering the question just answered.
            if afterAnswer, questions?.isEmpty == false { questions?.removeFirst() }
            return false
        }
    }
}

// MARK: - Settings

/// Which provider and model passes run on, checked against the chat catalogue.
public struct HeadsDownModelChoice: Sendable, Equatable {
    public var provider: String?
    public var model: String?
    /// Nil until the catalogue loads, so a saved model isn't called unavailable meanwhile.
    public var providers: [ProviderInfo]?

    public init(provider: String?, model: String?, providers: [ProviderInfo]?) {
        self.provider = provider
        self.model = model
        self.providers = providers
    }

    public func models(for provider: String?) -> [ModelInfo] {
        providers?.first { $0.id == provider }?.models ?? []
    }

    /// A saved provider the catalogue no longer lists, kept in the picker so
    /// it doesn't claim a different one than passes are set to use.
    public var providerMissing: Bool {
        provider != nil && !(providers?.contains { $0.id == provider } ?? false)
    }

    public var modelMissing: Bool {
        model != nil && !models(for: provider).contains { $0.id == model }
    }

    /// A pass on a model it can't resolve fails rather than falling back to the default.
    public var stale: Bool {
        guard let providers else { return false }
        return providerMissing || modelMissing || providers.contains { $0.id == provider && !$0.available }
    }

    /// Picking a provider picks its first model; one with no models means the default.
    public func picking(provider newProvider: String?) -> (provider: String?, model: String?) {
        guard let newProvider, let first = models(for: newProvider).first else { return (nil, nil) }
        return (newProvider, first.id)
    }
}

extension WorkingHours {
    /// Adds or removes a day, keeping the list sorted.
    public func toggling(day: Int) -> WorkingHours {
        var next = self
        next.days = days.contains(day) ? days.filter { $0 != day } : (days + [day]).sorted()
        return next
    }
}
