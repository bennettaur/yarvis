import Foundation

// What the verification checklist adds up to: a suggested decision on the
// PR with the reasons for it, the comments a "request changes" review would
// carry, and where to look when the answer is "review deeper". The rules are
// few and visible: the panel shows every reason, so the reviewer can see why
// it suggests what it does and disagree.

public enum ReviewSuggestion: String, Sendable, Equatable {
    case approve
    case requestChanges = "request_changes"
    case reviewDeeper = "review_deeper"
    case runChecks = "run_checks"

    /// What it says on the decision panel and in an exported report.
    public var label: String {
        switch self {
        case .approve: return "Looks ready to approve"
        case .requestChanges: return "Changes needed"
        case .reviewDeeper: return "Review deeper first"
        case .runChecks: return "Run the checks first"
        }
    }
}

public struct ReviewAssessment: Sendable, Equatable {
    public var suggestion: ReviewSuggestion
    /// Why changes are needed: each one is enough on its own.
    public var blockers: [String]
    /// What deserves a closer look before approving.
    public var concerns: [String]
    /// Labels of the default checks with no result for the PR's head.
    public var notRun: [String]
}

/// Impact bands run 1 to 5; 4 and 5 are the ones the sidecar calls high.
private let highImpactBand = 4

private func countFindings(_ report: VerificationReport, severity: String) -> Int {
    let inChecks = VerificationSections.checks.flatMap { report.check($0)?.findings ?? [] }
    return (inChecks + (report.claims?.gaps ?? [])).filter { $0.severity == severity }.count
}

/// The suggested decision. Changes are needed when CI fails, a scanner raised
/// a high alert, a claim isn't met, or a check found something high. A closer
/// look is due for a risky change, an outlier, a partial claim, a medium
/// finding, a simpler approach, a security bot's comment, CI that hasn't
/// passed, or a check not run on the PR's head.
///
/// `evidence` is nil when there is none for the PR's head: not loaded yet, or
/// read at another commit.
public func assessReview(report: VerificationReport?, evidence: [EvidenceItem]?, items: [ChecklistItem],
                         mutation: MutationRun? = nil, upstack: VerificationUpstack? = nil) -> ReviewAssessment {
    var blockers: [String] = []
    var concerns: [String] = []
    let judged = items.filter { VerificationSections.defaults.contains($0.section) }
    let notRun = judged.filter { $0.result?.current != true }.map(\.label)

    if let ci = evidence?.first(where: { $0.id == "ci-checks" }) {
        if ci.tone == "bad" { blockers.append("CI: \(ci.summary)") } else if ci.tone != "good" { concerns.append("CI: \(ci.summary)") }
    } else {
        concerns.append("No CI results for this commit yet")
    }
    let highAlerts = evidence?.first(where: { $0.id == "code-scanning" })?.entries.filter { $0.severity == "high" }.count ?? 0
    if highAlerts > 0 {
        blockers.append(reportPlural(highAlerts, "high code scanning alert", "high code scanning alerts"))
    }
    if let bots = evidence?.first(where: { $0.id == "security-bots" }), !bots.entries.isEmpty {
        concerns.append("Security bots commented: \(bots.summary)")
    }

    if let report {
        for c in report.claims?.items ?? [] where c.status == "missing" || c.status == "contradicted" {
            blockers.append("Claim \(c.status): \(c.claim)")
        }
        let partial = report.claims?.items.filter { $0.status == "partial" }.count ?? 0
        if partial > 0 { concerns.append(reportPlural(partial, "claim only partly met", "claims only partly met")) }

        let high = countFindings(report, severity: "high")
        if high > 0 { blockers.append(reportPlural(high, "high finding", "high findings")) }
        // Still a blocker: the PR's author controls the layer above, so it can
        // only point at where a fix may be. Only results for the current
        // commit have line numbers the layer's can be matched against.
        let current = Set(items.filter { $0.result?.current == true }.map(\.section))
        let above = VerificationSections.checks.filter(current.contains)
            .flatMap { report.check($0)?.findings ?? [] }
            .filter { $0.severity == "high" }
            .compactMap { changedUpstack(upstack, path: $0.path, line: $0.line) }
        if !above.isEmpty {
            var layers: [String] = []
            for l in above where !layers.contains("#\(l.number)") { layers.append("#\(l.number)") }
            concerns.append("\(reportPlural(above.count, "high finding is", "high findings are")) on lines that \(layers.joined(separator: ", ")) (stacked above) changes; check whether \(above.count == 1 ? "it's" : "they're") fixed there")
        }
        let medium = countFindings(report, severity: "medium")
        if medium > 0 { concerns.append(reportPlural(medium, "medium finding", "medium findings")) }

        if let risk = report.risk, risk.level == "high" || (risk.impact?.band ?? 0) >= highImpactBand {
            concerns.append("High risk: \(risk.clientImpact)")
        }
        let outliers = report.changeMap?.themes.filter { $0.cohesion == "outlier" } ?? []
        if !outliers.isEmpty {
            concerns.append("\(reportPlural(outliers.count, "change doesn't", "changes don't")) seem to belong to the PR's goal: \(outliers.map(\.title).joined(separator: ", "))")
        }
        if let rating = report.approach?.rating, rating == "simpler" || rating == "much-simpler" {
            concerns.append(rating == "much-simpler" ? "A much simpler way exists" : "A simpler way exists")
        }
    }

    // Mutation testing runs the PR's code, so it is opt-in: not having run it isn't a gap.
    if let mutation, mutation.isCurrentHead, mutation.status == "succeeded", let summary = mutation.summary,
       summary.verdict == "weak" || summary.verdict == "mixed" {
        concerns.append("Mutation testing: \(summary.verdict), \(reportPlural(summary.survived, "mutant", "mutants")) the tests missed")
    }

    let nothingRun = !judged.isEmpty && notRun.count == judged.count
    let suggestion: ReviewSuggestion
    if !blockers.isEmpty {
        suggestion = .requestChanges
    } else if nothingRun {
        suggestion = .runChecks
    } else if !concerns.isEmpty || !notRun.isEmpty {
        suggestion = .reviewDeeper
    } else {
        suggestion = .approve
    }
    return ReviewAssessment(suggestion: suggestion, blockers: blockers, concerns: concerns, notRun: notRun)
}

/// A comment a "request changes" review can carry, drafted from the report.
public struct DraftComment: Sendable, Equatable, Identifiable {
    /// Built from what the comment is about, so it names the same comment when the report refreshes.
    public var id: String
    /// Where it came from, as the report labels it.
    public var source: String
    public var title: String
    /// The comment text, made safe to post; the reviewer can edit it.
    public var body: String
    public var severity: String
    /// With both, it goes on its line; without, into the review's summary.
    public var path: String?
    public var line: Int?
    /// Ticked at first: the ones a reviewer would almost always raise.
    public var pickedByDefault: Bool

    public var isOnLine: Bool { path != nil && line != nil }
}

/// Comments for a "request changes" review: unmet claims, outlier questions,
/// unfinished work, high and medium findings, risk concerns, and failing CI.
/// Only results for the PR's head go on a line, since an older head's line
/// numbers may point at different code now; `currentSections` names those.
public func draftComments(report: VerificationReport?, evidence: [EvidenceItem]?,
                          currentSections: Set<String>) -> [DraftComment] {
    var drafts: [DraftComment] = []
    var ids = Set<String>()
    func add(section: String, source: String, title: String, detail: String, severity: String,
             path: String? = nil, line: Int? = nil, pickedByDefault: Bool) {
        let located = currentSections.contains(section) && path?.isEmpty == false && (line ?? 0) != 0
        let base = "\(section):\(path ?? ""):\(line.map(String.init) ?? ""):\(title)"
        var id = base
        // Two identical results would share an id; the next gets a suffix.
        var n = 2
        while ids.contains(id) {
            id = "\(base)#\(n)"
            n += 1
        }
        ids.insert(id)
        drafts.append(DraftComment(
            id: id, source: source, title: title,
            body: findingCommentBody(title: title, detail: detail, severity: severity, section: source),
            severity: severity, path: located ? path : nil, line: located ? line : nil,
            pickedByDefault: pickedByDefault))
    }

    if let report {
        for c in report.claims?.items ?? [] where c.status != "verified" && c.status != "unverifiable" {
            let severity = c.status == "partial" ? "medium" : "high"
            add(section: "claims", source: "Claims: \(c.status)", title: c.claim, detail: c.evidence,
                severity: severity, path: c.path, line: c.line, pickedByDefault: severity == "high")
        }
        for t in report.changeMap?.themes ?? [] {
            guard t.cohesion == "outlier", !t.question.isEmpty, let first = t.files.first else { continue }
            add(section: "changeMap", source: "Change map", title: t.title, detail: t.question, severity: "medium",
                path: first.path, line: first.lines?.start ?? 1, pickedByDefault: true)
        }
        for g in report.claims?.gaps ?? [] where g.severity != "low" {
            add(section: "claims", source: "Unfinished work", title: g.title, detail: g.detail, severity: g.severity,
                path: g.path, line: g.line, pickedByDefault: g.severity == "high")
        }
        for key in VerificationSections.checks {
            for f in report.check(key)?.findings ?? [] where f.severity != "low" {
                add(section: key, source: verificationCheckLabels[key] ?? key, title: f.title, detail: f.detail,
                    severity: f.severity, path: f.path, line: f.line, pickedByDefault: f.severity == "high")
            }
        }
        for c in report.risk?.concerns ?? [] {
            add(section: "risk", source: "Risk", title: c.title, detail: c.detail, severity: "medium",
                path: c.path, line: c.line, pickedByDefault: false)
        }
    }

    // A failing check, for the summary. Its annotations are left out: they
    // already show on the PR's lines, where the check put them.
    for e in evidence?.first(where: { $0.id == "ci-checks" })?.entries ?? [] where e.severity == "high" && e.path == nil {
        add(section: "evidence", source: "CI", title: e.title, detail: e.detail, severity: "high", pickedByDefault: true)
    }
    return drafts
}

/// The review's summary: each picked comment with no line, whole, then how
/// many went on the diff.
public func reviewSummary(_ picked: [DraftComment]) -> String {
    let onDiff = picked.filter(\.isOnLine)
    var parts = ["Requesting changes based on the verification report."]
    parts += picked.filter { !$0.isOnLine }.map(\.body)
    if !onDiff.isEmpty {
        parts.append("\(reportPlural(onDiff.count, "more comment is", "more comments are")) on the diff.")
    }
    return parts.joined(separator: "\n\n")
}

/// A place to read when the answer is "review deeper".
public struct ReviewPlace: Sendable, Equatable {
    public var path: String
    public var line: Int?
    /// Why to look there.
    public var reason: String
}

/// Where a closer look pays: outlier and high-risk themes, then the must-read
/// files, then each high finding's line. A file appears once, under its first reason.
public func whereToLook(_ report: VerificationReport?) -> [ReviewPlace] {
    guard let report else { return [] }
    var places: [ReviewPlace] = []
    var seen = Set<String>()
    func add(_ path: String, _ line: Int?, _ reason: String) {
        guard seen.insert(path).inserted else { return }
        places.append(ReviewPlace(path: path, line: line, reason: reason))
    }
    let themes = report.changeMap?.themes ?? []
    for t in themes where t.cohesion == "outlier" {
        for f in t.files { add(f.path, f.lines?.start, "Outlier: \(t.title)") }
    }
    for t in themes where t.risk == "high" && t.cohesion != "outlier" {
        for f in t.files { add(f.path, f.lines?.start, "High risk: \(t.title)") }
    }
    for m in report.mustRead ?? [] { add(m.path, m.lines?.start, m.reason) }
    for key in VerificationSections.checks {
        for f in report.check(key)?.findings ?? [] where f.severity == "high" {
            if let path = f.path { add(path, f.line, "\(verificationCheckLabels[key] ?? key): \(f.title)") }
        }
    }
    return places
}
