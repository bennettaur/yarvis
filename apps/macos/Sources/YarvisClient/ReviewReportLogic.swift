import Foundation

// What the agent tabs (since last review, verification, mutation testing,
// guided review) say about their data, as pure functions.

/// How a chip reads: good is green, warn amber, bad red, muted grey.
public enum ReportTone: String, Sendable, Equatable {
    case good, warn, bad, muted
}

/// A chip's text and tone.
public struct ReportChip: Sendable, Equatable {
    public var text: String
    public var tone: ReportTone

    public init(_ text: String, _ tone: ReportTone) {
        self.text = text
        self.tone = tone
    }
}

func reportPlural(_ n: Int, _ one: String, _ many: String) -> String {
    "\(n) \(n == 1 ? one : many)"
}

public func reportSha(_ sha: String?) -> String {
    guard let sha, !sha.isEmpty else { return "unknown" }
    return String(sha.prefix(7))
}

// MARK: Findings as comments

/// Breaks every `@name` so posting the text can't notify anyone or reach a
/// bot that reads commands addressed to it.
func unmention(_ text: String) -> String {
    text.replacingOccurrences(of: #"@(?=[\w-])"#, with: "@\u{200B}", options: .regularExpression)
}

/// A finding as a review comment's text: its title, then what the report
/// said, quoted. The text is model-written from the PR's code and posts under
/// the reviewer's account, so it is quoted, stripped of mentions, and the
/// title kept to one line, where a `/approve` or `@bot` would carry their authority.
public func findingCommentBody(title: String, detail: String, severity: String?, section: String) -> String {
    let tag = severity.map { "\(section), \($0)" } ?? section
    let quoted = unmention(detail).components(separatedBy: "\n").map { "> \($0)" }.joined(separator: "\n")
    return "**\(oneLine(unmention(title)))** (verification report: \(tag))\n\n\(quoted)"
}

/// Lines either side of a stacked layer's change that still count as near it.
private let upstackNearbyLines = 3

/// The PR stacked above that changes `path` at or near `line`, so a finding
/// there may be fixed in it. A layer whose changes weren't read is skipped.
public func changedUpstack(_ upstack: VerificationUpstack?, path: String?,
                           line: Int?) -> VerificationUpstack.Layer? {
    guard let upstack, let path else { return nil }
    for layer in upstack.layers where !layer.stale {
        guard let file = layer.files.first(where: { $0.path == path }) else { continue }
        guard let ranges = file.ranges, let line else { return layer }
        if ranges.contains(where: { line >= $0.start - upstackNearbyLines && line <= $0.end + upstackNearbyLines }) {
            return layer
        }
    }
    return nil
}

// MARK: Verification checklist

public let approachLabels: [String: String] = [
    "much-simpler": "A much simpler way exists",
    "simpler": "A simpler way exists",
    "no-simpler": "No simpler way found",
    "unrated": "Not rated",
]

public let impactLabels: [Int: String] = [1: "minimal", 2: "low", 3: "moderate", 4: "high", 5: "very high"]

/// The risk level an impact band implies, mirroring the sidecar's; the level
/// shows beside the band only when the agent judged it differently.
public func riskLevel(forBand band: Int) -> String {
    band >= 4 ? "high" : band == 3 ? "medium" : "low"
}

/// From this band up, a change is listed under "Needs attention".
public let attentionBand = 4

public let tripwireLabels: [String: String] = [
    "build": "Runs code or sets rules",
    "binary": "Binary",
    "hidden-text": "Hidden text",
    "opaque-blob": "Encoded string",
    "test-tampering": "Tests",
]

private let changeKindNames: [(String, String, String)] = [
    ("passive", "passive", "passive"),
    ("reorganization", "reorganization", "reorganizations"),
    ("addition", "addition", "additions"),
    ("removal", "removal", "removals"),
    ("interface", "interface change", "interface changes"),
    ("logic", "logic change", "logic changes"),
]

/// "3 additions, 1 logic change": the impact's changes counted by kind.
public func impactCountsText(_ counts: [String: Int]) -> String {
    changeKindNames.compactMap { kind, one, many in
        guard let n = counts[kind], n > 0 else { return nil }
        return reportPlural(n, one, many)
    }.joined(separator: ", ")
}

private let evidenceText = ["proven": "proven by tests", "partial": "partly tested", "unproven": "untested"]

public func describeChange(_ change: VerificationChange) -> String {
    var parts = [change.kind, change.reach, evidenceText[change.evidence] ?? change.evidence]
    if change.sensitive { parts.append("sensitive") } else if change.internal == true { parts.append("internal only") }
    if change.count > 1 { parts.append("\(change.count) like it") }
    return parts.joined(separator: " · ")
}

/// The chip a checklist row shows for its section's newest result.
public func resultVerdict(section: String, report: VerificationReport) -> ReportChip? {
    switch section {
    case "summary":
        guard report.summary != nil else { return nil }
        let n = report.mustRead?.count ?? 0
        return ReportChip(n > 0 ? reportPlural(n, "must-read file", "must-read files") : "Summary", .muted)
    case "risk":
        guard let risk = report.risk else { return nil }
        let tone: ReportTone = risk.level == "high" ? .bad : risk.level == "medium" ? .warn : .good
        return ReportChip(risk.impact.map { "Impact \($0.band)/5" } ?? "\(risk.level) risk", tone)
    case "approach":
        guard let approach = report.approach else { return nil }
        switch approach.rating {
        case "no-simpler": return ReportChip("No simpler way", .good)
        case "unrated": return ReportChip("Not rated", .muted)
        case "much-simpler": return ReportChip("Much simpler way", .bad)
        default: return ReportChip("Simpler way", .warn)
        }
    case "changeMap":
        guard let map = report.changeMap else { return nil }
        // No themes but changed files means the map failed, which isn't a clean result.
        if map.themes.isEmpty && !map.unmapped.isEmpty { return ReportChip("Not mapped", .warn) }
        let outliers = map.themes.filter { $0.cohesion == "outlier" }.count
        let themes = reportPlural(map.themes.count, "theme", "themes")
        return outliers > 0
            ? ReportChip("\(themes), \(reportPlural(outliers, "outlier", "outliers"))", .warn)
            : ReportChip(themes, .muted)
    case "claims":
        guard let claims = report.claims else { return nil }
        let verified = claims.items.filter { $0.status == "verified" }.count
        let unmet = claims.items.contains { $0.status == "missing" || $0.status == "contradicted" }
        let attention = claims.items.contains { $0.status == "partial" } || !claims.gaps.isEmpty
        let tone: ReportTone = unmet ? .bad : attention ? .warn : .good
        if !claims.items.isEmpty { return ReportChip("\(verified) of \(claims.items.count) verified", tone) }
        if !claims.gaps.isEmpty { return ReportChip(reportPlural(claims.gaps.count, "gap", "gaps"), tone) }
        return ReportChip("No claims", .muted)
    case "flow":
        guard let flow = report.flow else { return nil }
        return ReportChip(flow.mermaid.isEmpty ? "Not drawn" : "Drawn", .muted)
    default:
        guard let check = report.check(section) else { return nil }
        if check.findings.isEmpty { return ReportChip("Pass", .good) }
        let high = check.findings.contains { $0.severity == "high" }
        return ReportChip(reportPlural(check.findings.count, "finding", "findings"), high ? .bad : .warn)
    }
}

/// The sections ticked until the reviewer chooses: every default section with
/// no result for the PR's head and no run going.
public func suggestedSections(_ items: [ChecklistItem]) -> [String] {
    items.filter {
        VerificationSections.defaults.contains($0.section) && $0.result?.current != true && $0.latest?.status != "running"
    }.map(\.section)
}

/// The tickets typed for a run: split on spaces and commas, at most `maxNamedTickets`.
public func parseNamedTickets(_ text: String) -> [String] {
    Array(text.split(whereSeparator: { $0.isWhitespace || $0 == "," }).map(String.init)
        .prefix(VerificationSections.maxNamedTickets))
}

public let mutationVerdictChips: [String: ReportChip] = [
    "strong": ReportChip("Strong", .good),
    "mixed": ReportChip("Mixed", .warn),
    "weak": ReportChip("Weak", .bad),
    "inconclusive": ReportChip("Inconclusive", .muted),
]

/// The checklist's mutation-testing row chip for a pass that isn't running.
public func mutationChip(_ run: MutationRun) -> ReportChip? {
    if run.status == "failed" { return ReportChip("Last pass failed", .bad) }
    if run.status == "cancelled" { return ReportChip("Last pass cancelled", .muted) }
    guard let summary = run.summary else { return nil }
    let verdict = mutationVerdictChips[summary.verdict] ?? ReportChip(summary.verdict, .muted)
    let killed = summary.valid > 0 ? ": \(summary.killed) of \(summary.valid) mutants caught" : ""
    return ReportChip(verdict.text + killed, verdict.tone)
}

/// The sentence before a list of paths an agent run won't read whole.
public struct FileNotice: Sendable, Equatable {
    public var text: String
    public var paths: [String]
}

/// One notice per kind of file the run won't read whole; those with no paths are left out.
public func fileNotices(binary: [String], truncated: [String] = [], noInterdiff: [String] = [],
                        skimmed: [String]) -> [FileNotice] {
    [
        FileNotice(text: "\(reportPlural(binary.count, "binary file has", "binary files have")) no diff to read",
                   paths: binary),
        FileNotice(text: "\(reportPlural(truncated.count, "diff is", "diffs are")) too large and will be cut off, so the agents see only the start",
                   paths: truncated),
        FileNotice(text: "\(reportPlural(noInterdiff.count, "file has", "files have")) a version too large to compare, so no interdiff",
                   paths: noInterdiff),
        FileNotice(text: "\(reportPlural(skimmed.count, "file is", "files are")) bulk (a lockfile, or generated, vendored or minified code) that the agents only skim",
                   paths: skimmed),
    ].filter { !$0.paths.isEmpty }
}

/// The estimate against the budget. The budget only warns: past it, the run still finishes.
public func costLine(estimatedUsd: Double, budgetUsd: Double, overBudget: Bool) -> String {
    let line = "Estimated cost: about \(reportMoney(estimatedUsd)), against a budget of \(reportMoney(budgetUsd))."
    return overBudget ? line + " That's over the budget, and the run won't stop when it reaches it." : line
}

public func reportMoney(_ usd: Double) -> String {
    String(format: "$%.2f", usd)
}

// MARK: Since last review

/// How the last-review mark was made, finishing "You reviewed abc1234 …".
public func markSourceText(_ mark: ReviewMark, ref: PrRef) -> String {
    switch mark.source {
    case "review": return "when you submitted a review here"
    case "comment": return "when you commented here"
    case "manual": return "when you marked it reviewed"
    default: return "in your review on \(ref.providerName)"
    }
}

public func sinceSummaryLine(_ since: SinceReview) -> String {
    let fresh = since.commits.filter(\.isNew).count
    var parts = [reportPlural(fresh, "new commit", "new commits"), "\(reportPlural(since.files.count, "file", "files")) changed"]
    if since.rebased && since.baseMoved {
        parts.append("rebased onto a newer base")
    } else if since.rebased {
        parts.append("history rewritten (force-push)")
    } else if since.baseMoved {
        parts.append("base branch merged in")
    }
    return parts.joined(separator: " · ")
}

public let sinceStatusLabels = ["added": "Newly changed", "modified": "Changed again", "reverted": "Reverted"]

// MARK: Re-review

public let rereviewVerdictLabels: [String: String] = [
    "not_addressed": "Not addressed",
    "partly": "Partly",
    "unclear": "Unclear",
    "disagreed": "Disagreed",
    "addressed": "Addressed",
]

/// The reviewer's comments by what became of them. Open ones are sorted
/// worst first; a comment is settled once addressed or its thread resolved.
public struct RereviewGroups: Sendable, Equatable {
    public var open: [RereviewComment]
    public var disagreed: [RereviewComment]
    public var addressed: [RereviewComment]
}

private let openVerdictOrder = ["not_addressed", "partly", "unclear"]

public func groupRereviewComments(_ comments: [RereviewComment],
                                  resolved: @escaping (RereviewComment) -> Bool = { $0.resolved }) -> RereviewGroups {
    let settled = { (c: RereviewComment) in c.verdict == "addressed" || resolved(c) }
    let open = comments.filter { !settled($0) && openVerdictOrder.contains($0.verdict) }
        .enumerated()
        .sorted {
            let a = openVerdictOrder.firstIndex(of: $0.element.verdict)!, b = openVerdictOrder.firstIndex(of: $1.element.verdict)!
            return (a, $0.offset) < (b, $1.offset)
        }
        .map(\.element)
    return RereviewGroups(open: open, disagreed: comments.filter { !settled($0) && $0.verdict == "disagreed" },
                          addressed: comments.filter(settled))
}

/// Ready once the agent said so, or once nothing it raised is still open:
/// resolving the threads that held it back settles it without a re-run.
public func rereviewReady(_ review: Rereview, groups: RereviewGroups) -> Bool {
    review.verdict == "ready_to_approve"
        || (groups.open.isEmpty && groups.disagreed.isEmpty && !review.newChanges.contains { $0.kind == "needs_review" })
}

/// Whether the summary should start on its own: once per range, when the
/// setting allows it, nothing covers the range yet and it is within budget.
public func shouldAutoStartRereview(_ latest: LatestRereview, autoStart: Bool, alreadyStarted: Bool) -> Bool {
    guard autoStart, !alreadyStarted, !latest.current else { return false }
    if latest.lastSucceeded?.current == true || latest.run?.status == "running" { return false }
    if let size = latest.size, size.overBudget || size.overAgentBudget { return false }
    return true
}

// MARK: Mutation testing

public func killRateText(_ summary: MutationSummary) -> String {
    guard summary.valid > 0 else { return "No mutant gave a result." }
    let caught = summary.killed + summary.timeouts
    return "The tests caught \(caught) of \(summary.valid) mutants (\(Int(((summary.killRate ?? 0) * 100).rounded()))%)."
}

public let mutationVerdictSentences: [String: String] = [
    "strong": "The tests caught nearly every change to the code this PR touches.",
    "mixed": "The tests caught most changes, but some got through.",
    "weak": "Many changes to this code went unnoticed by the tests.",
    "inconclusive": "Too few mutants gave a result to judge the tests.",
]

/// Where the mutation tab stands, from the stored pass and the stream it follows.
public struct MutationTabState: Sendable, Equatable {
    public var follow: AgentRunFollow
    public var canStart: Bool

    public var running: Bool { follow.running }
    public var runningElsewhere: Bool { follow.runningElsewhere }
    public var lostTrack: Bool { follow.lostTrack }

    public init(run: MutationRun?, startedId: String?, progress: MutationProgress?, blocked: Bool, confirming: Bool) {
        follow = AgentRunFollow(
            startedId: startedId, runId: run?.id, runStatus: run?.status, runLive: run?.live,
            streamOpen: progress.map { $0.finished == nil && !$0.streamEnded } ?? false,
            streamEnded: progress?.streamEnded == true, storedMustRun: true)
        canStart = !follow.running && !follow.runningElsewhere && !follow.lostTrack && !blocked && !confirming
    }
}

/// Where the re-review summary stands. Following lasts until the run's
/// `done`; the stored run isn't consulted, since it is re-read only then.
public func rereviewFollow(_ latest: LatestRereview?, startedId: String?, progress: RereviewProgress?) -> AgentRunFollow {
    AgentRunFollow(startedId: startedId, runId: latest?.run?.id, runStatus: latest?.run?.status,
                   runLive: latest?.run?.live, streamOpen: progress.map { $0.finished == nil } ?? false,
                   streamEnded: progress?.finished != nil, storedMustRun: false)
}

// MARK: Guided review

/// Where a step points: `path`, `path:12` or `path:12–20`.
public func guideStepLocation(_ step: PrGuideStep) -> String {
    guard let start = step.startLine else { return step.path }
    if let end = step.endLine, end > start { return "\(step.path):\(start)–\(end)" }
    return "\(step.path):\(start)"
}

public let guideStepKindLabels = ["data": "Data sanity check", "tests": "Test sanity check"]

public let guideFindingKindLabels: [String: String] = [
    "error-handling": "error handling",
    "stale-comment": "stale comment",
    "test-gap": "test gap",
    "brittle-test": "brittle test",
    "naming": "naming",
    "convention": "convention",
    "other": "flagged",
]

/// A move through a guided review.
public enum GuideMove: Sendable, Equatable {
    case goTo(Int)
    case next
    case back
    case finish
}

/// What a move does: the step to show, the paths to mark viewed, and
/// whether the guide ends.
public struct GuideMoveResult: Sendable, Equatable {
    public var step: Int
    public var markViewed: [String]
    public var dismiss: Bool
}

/// The step a guide opens on: the saved one, kept within the steps.
public func guideInitialStep(_ guide: PrGuide) -> Int {
    min(max(guide.currentStep, 0), max(guide.steps.count - 1, 0))
}

/// Moving on past a step marks its paths viewed, and so does finishing;
/// going back marks nothing and unmarks nothing.
public func guideMove(_ guide: PrGuide, from step: Int, _ move: GuideMove) -> GuideMoveResult {
    let last = max(guide.steps.count - 1, 0)
    let clamp = { (i: Int) in min(max(i, 0), last) }
    let paths = guide.steps.indices.contains(step) ? guide.steps[step].paths : []
    switch move {
    case .goTo(let i): return GuideMoveResult(step: clamp(i), markViewed: [], dismiss: false)
    case .next: return GuideMoveResult(step: clamp(step + 1), markViewed: paths, dismiss: false)
    case .back: return GuideMoveResult(step: clamp(step - 1), markViewed: [], dismiss: false)
    case .finish: return GuideMoveResult(step: step, markViewed: paths, dismiss: true)
    }
}

// MARK: Verification inputs

/// What the decision panel and export judge by. CI results or a stack read
/// at another commit than the checklist's would point at different lines, so
/// they are left out.
public struct DecisionInputs: Sendable, Equatable {
    public var evidence: [EvidenceItem]?
    public var upstack: VerificationUpstack?
    /// Sections whose result is for the PR's head.
    public var currentSections: Set<String>
}

public func decisionInputs(checklist: VerificationChecklist, evidence: VerificationEvidence?,
                           upstack: VerificationUpstack?) -> DecisionInputs {
    DecisionInputs(
        evidence: evidence.flatMap { $0.headSha == checklist.headSha ? $0.items : nil },
        upstack: upstack.flatMap { $0.headSha == checklist.headSha ? $0 : nil },
        currentSections: Set(checklist.items.filter { $0.result?.current == true }.map(\.section)))
}

/// What a "Run" sends beyond its sections. Empty picks mean the Settings choice.
public struct VerificationRunRequest: Sendable, Equatable {
    public var namedTickets: [String]
    public var choice: VerificationRunChoice
    public var harness: String?
}

/// `typedTickets` is nil until the reviewer types, and the checklist's last
/// tickets are offered again until then.
public func verificationRunRequest(typedTickets: String?, savedTickets: [String], model: String, effort: String,
                                   harness: String) -> VerificationRunRequest {
    VerificationRunRequest(
        namedTickets: parseNamedTickets(typedTickets ?? savedTickets.joined(separator: ", ")),
        choice: VerificationRunChoice(model: model.isEmpty ? nil : model, effort: effort.isEmpty ? nil : effort),
        harness: harness.isEmpty ? nil : harness)
}

/// The ticks after a run starts: only the sections that started are
/// unticked, and with none left the suggestions return (nil).
public func pickedAfterStart(_ picked: [String]?, started: Set<String>) -> [String]? {
    guard let picked else { return nil }
    let left = picked.filter { !started.contains($0) }
    return left.isEmpty ? nil : left
}
