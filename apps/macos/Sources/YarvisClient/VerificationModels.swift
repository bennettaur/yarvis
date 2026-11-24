import Foundation

// The verification report and mutation testing shapes, from the web's
// `src/lib/reviewWorkspaces/{verification,mutation}.ts` and the sidecar's
// `reviewWorkspaces/checklist.ts`. All of the report's text is model-written
// from the PR's code, so it is shown as plain text, never Markdown.

public struct VerificationFinding: Codable, Sendable, Equatable, Hashable {
    public var title: String
    public var detail: String
    /// "high", "medium" or "low".
    public var severity: String
    public var path: String?
    public var line: Int?
}

/// One check's verdict: "pass" exactly when it has no findings, else "issues".
public struct VerificationCheck: Codable, Sendable, Equatable {
    public var status: String
    public var findings: [VerificationFinding]
}

/// The malicious-intent check, plus what the sidecar's fixed rules found.
public struct MaliceCheck: Codable, Sendable, Equatable {
    public var status: String
    public var findings: [VerificationFinding]
    public var tripwires: [VerificationTripwire]?
    public var tripwiresOmitted: Int?
}

/// `kind` is "build", "binary", "hidden-text", "opaque-blob" or "test-tampering".
public struct VerificationTripwire: Codable, Sendable, Equatable, Hashable {
    public var kind: String
    public var path: String
    public var line: Int?
    public var note: String
}

public struct VerificationConcern: Codable, Sendable, Equatable, Hashable {
    public var title: String
    public var detail: String
    public var path: String?
    public var line: Int?
}

/// A scored change from the sidecar's `verify/impact.ts`. `band` is 1–5.
public struct VerificationChange: Codable, Sendable, Equatable, Hashable {
    /// "passive", "reorganization", "addition", "removal", "interface" or "logic".
    public var kind: String
    public var title: String
    /// "leaf", "local", "shared" or "core".
    public var reach: String
    /// "proven", "partial" or "unproven".
    public var evidence: String
    public var sensitive: Bool
    public var `internal`: Bool?
    public var count: Int
    /// What a reviewer should confirm; empty below the attention band.
    public var check: String
    public var path: String?
    public var line: Int?
    public var band: Int
}

public struct VerificationImpact: Codable, Sendable, Equatable {
    public var band: Int
    /// Below `band` when the number of changes raised it.
    public var highestChangeBand: Int
    public var load: Double
    public var raisedByVolume: Double
    /// Keyed by change kind.
    public var counts: [String: Int]
    /// Highest band first.
    public var changes: [VerificationChange]
}

public struct VerificationRisk: Codable, Sendable, Equatable {
    /// "low", "medium" or "high".
    public var level: String
    public var clientImpact: String
    public var mitigations: [String]
    public var concerns: [VerificationConcern]
    public var impact: VerificationImpact?
}

public struct VerificationMustRead: Codable, Sendable, Equatable, Hashable {
    public struct Flag: Codable, Sendable, Equatable, Hashable {
        public var note: String
        public var line: Int?
    }

    public var path: String
    public var reason: String
    public var lines: LineRange?
    public var flags: [Flag]?
}

/// Which changed files the run's agents read, counted by the sidecar. When
/// counting failed the sidecar sends only `{unknown: true}`.
public struct ReportCoverage: Codable, Sendable, Equatable {
    public struct Skimmed: Codable, Sendable, Equatable, Hashable {
        public var path: String
        public var kind: String
    }

    public struct NotExamined: Codable, Sendable, Equatable, Hashable {
        public var path: String
        public var reason: String
    }

    public struct LaneGap: Codable, Sendable, Equatable, Hashable {
        public var check: String
        public var paths: [String]
    }

    public var unknown: Bool?
    public var examined: Int?
    public var total: Int?
    public var skimmed: [Skimmed]?
    public var notExamined: [NotExamined]?
    public var laneGaps: [LaneGap]?

    public var isKnown: Bool { unknown != true && examined != nil }
}

/// A Mermaid flowchart of the flow the change sits in; `mermaid` is empty
/// when there was none to draw.
public struct VerificationFlow: Codable, Sendable, Equatable {
    public var title: String
    public var explanation: String
    public var mermaid: String
    public var tooLarge: Bool?
}

/// `rating` is "no-simpler", "simpler", "much-simpler" or "unrated".
public struct VerificationApproach: Codable, Sendable, Equatable {
    public var rating: String
    public var reason: String
    public var alternative: String
    public var path: String?
    public var line: Int?
}

public struct ChangeTheme: Codable, Sendable, Equatable, Hashable {
    public struct File: Codable, Sendable, Equatable, Hashable {
        public var path: String
        public var lines: LineRange?
    }

    public var title: String
    public var description: String
    /// "low", "medium" or "high".
    public var risk: String
    /// "core", "supporting" or "outlier".
    public var cohesion: String
    /// For an outlier, what to ask the author; empty otherwise.
    public var question: String
    public var files: [File]
}

public struct VerificationChangeMap: Codable, Sendable, Equatable {
    public var intent: String
    public var themes: [ChangeTheme]
    /// Changed files no theme names.
    public var unmapped: [String]
}

public struct VerificationClaim: Codable, Sendable, Equatable, Hashable {
    public var claim: String
    /// "title", "description", or a ticket's key.
    public var source: String
    /// "verified", "partial", "missing", "contradicted" or "unverifiable".
    public var status: String
    public var evidence: String
    public var path: String?
    public var line: Int?
}

public struct VerificationClaims: Codable, Sendable, Equatable {
    public struct Ticket: Codable, Sendable, Equatable, Hashable {
        public var key: String
        public var title: String
        public var url: String
    }

    public var items: [VerificationClaim]
    /// Unfinished work no claim covers.
    public var gaps: [VerificationFinding]
    public var tickets: [Ticket]?
    /// Tickets named but not read, and why.
    public var ticketNotes: [String]?
}

/// Each section's newest result put together. A section with no result is absent.
public struct VerificationReport: Codable, Sendable, Equatable {
    public var summary: String?
    /// The sidecar leaves it out when there is no summary result.
    public var mustRead: [VerificationMustRead]?
    public var changeMap: VerificationChangeMap?
    public var claims: VerificationClaims?
    public var risk: VerificationRisk?
    public var malice: MaliceCheck?
    public var tests: VerificationCheck?
    public var complexity: VerificationCheck?
    public var performance: VerificationCheck?
    public var comments: VerificationCheck?
    public var observability: VerificationCheck?
    public var quality: VerificationCheck?
    public var approach: VerificationApproach?
    public var flow: VerificationFlow?
    public var coverage: ReportCoverage?

    /// The findings-only checks by key; the malicious-intent check's findings
    /// come from `malice`.
    public func check(_ key: String) -> VerificationCheck? {
        switch key {
        case "malice": return malice.map { VerificationCheck(status: $0.status, findings: $0.findings) }
        case "tests": return tests
        case "complexity": return complexity
        case "performance": return performance
        case "comments": return comments
        case "observability": return observability
        case "quality": return quality
        default: return nil
        }
    }
}

/// What the agents won't read whole.
public struct VerificationSize: Codable, Sendable, Equatable {
    public var binary: [String]
    public var truncated: [String]
    public var skimmed: [String]
}

/// A run's state, without its answer. `status` is "running", "succeeded",
/// "failed" or "cancelled".
public struct ChecklistRun: Codable, Sendable, Equatable {
    public var id: String
    public var status: String
    /// This sidecar is running it, so its events can be followed.
    public var live: Bool
    public var headSha: String?
    /// True when `headSha` is the PR's head now.
    public var current: Bool
    public var error: String?
    public var costUsd: Double?
    public var startedAt: String
    public var finishedAt: String?
}

public struct ChecklistItem: Codable, Sendable, Equatable {
    /// One of `VerificationSections.all`.
    public var section: String
    /// "understand", "correctness", "risk" or "maintainability".
    public var theme: String
    public var label: String
    public var description: String
    /// The newest run that wrote this section, whatever its outcome.
    public var latest: ChecklistRun?
    /// The newest run that answered for it: the one the report shows.
    public var result: ChecklistRun?
}

public struct VerificationChecklist: Codable, Sendable, Equatable {
    public struct Theme: Codable, Sendable, Equatable, Hashable {
        public var id: String
        public var label: String
    }

    public var headSha: String?
    public var themes: [Theme]
    /// In report order.
    public var items: [ChecklistItem]
    public var report: VerificationReport?
    /// Nil until the PR is ready to read.
    public var size: VerificationSize?
    /// The tickets named for the newest run that read tickets, to offer again.
    public var namedTickets: [String]
}

/// The report's sections, in report order, as the sidecar's `REPORT_SECTIONS` lists them.
public enum VerificationSections {
    public static let checks = ["malice", "tests", "complexity", "performance", "comments", "observability", "quality"]
    public static let all = ["summary", "changeMap", "claims", "risk"] + checks + ["approach", "flow"]
    /// What runs when none are picked: everything but the diagram.
    public static let defaults = all.filter { $0 != "flow" }
    /// Mirrors the sidecar's `MAX_NAMED_TICKETS`.
    public static let maxNamedTickets = 5
}

public struct StartedCheck: Codable, Sendable, Equatable {
    public var section: String
    public var runId: String
    public var existing: Bool
}

public struct StartedVerification: Codable, Sendable, Equatable {
    public struct Failure: Codable, Sendable, Equatable {
        public var section: String
        public var error: String
    }

    public var runs: [StartedCheck]
    public var failed: [Failure]
}

/// A model and effort for every check of one run, over the Settings choice.
public struct VerificationRunChoice: Sendable, Equatable {
    /// "sonnet", "opus" or "haiku".
    public var model: String?
    /// "low", "medium", "high", "xhigh" or "max".
    public var effort: String?

    public init(model: String? = nil, effort: String? = nil) {
        self.model = model
        self.effort = effort
    }
}

/// `GET /api/pr-models/verification`: the tab reads the harnesses and the
/// Settings defaults from it.
public struct VerificationRunConfig: Codable, Sendable, Equatable {
    public struct Harness: Codable, Sendable, Equatable, Hashable {
        public var id: String
        public var name: String
    }

    public struct SectionDefault: Codable, Sendable, Equatable, Hashable {
        public var section: String
        public var label: String
        public var model: String
        public var effort: String
    }

    public var maxBudgetUsd: Double
    public var harness: String?
    public var harnesses: [Harness]
    public var sectionDefaults: [SectionDefault]?
}

// MARK: CI evidence and the stack above

public struct EvidenceEntry: Codable, Sendable, Equatable, Hashable {
    public var source: String
    public var title: String
    public var detail: String
    /// "high", "medium", "low" or "info".
    public var severity: String
    public var path: String?
    public var line: Int?
    public var url: String?
}

public struct EvidenceItem: Codable, Sendable, Equatable {
    /// "ci-checks", "code-scanning", "security-bots", "coverage-bots" or "other-bots".
    public var id: String
    public var theme: String
    public var label: String
    public var description: String
    public var summary: String
    /// "good", "warn", "bad" or "muted".
    public var tone: String
    public var entries: [EvidenceEntry]
    public var hiddenEntries: Int
    public var note: String?
}

/// CI checks, code scanning and bot comments for the PR's head.
public struct VerificationEvidence: Codable, Sendable, Equatable {
    public var headSha: String
    public var items: [EvidenceItem]
}

/// What the PRs stacked above this one change, so a finding they touch can say so.
public struct VerificationUpstack: Codable, Sendable, Equatable {
    public struct Layer: Codable, Sendable, Equatable {
        public struct File: Codable, Sendable, Equatable {
            public var path: String
            /// Nil when the whole file counts.
            public var ranges: [LineRange]?
        }

        public var number: Int
        public var url: String
        public var stale: Bool
        public var files: [File]
    }

    public var headSha: String?
    public var layers: [Layer]
    public var note: String?
}

// MARK: Mutation testing

public struct BaselineResult: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var argv: [String]
    public var testFiles: [String]
    public var passed: Bool
    public var exitCode: Int?
    public var durationMs: Double
    public var testCount: Int?
    public var problem: String?
    public var excerpt: String?
}

public struct MutantResult: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var path: String
    public var line: Int
    public var oldText: String
    public var newText: String
    public var description: String
    public var rationale: String?
    public var testCommandId: String?
    public var testFiles: [String]
    /// "killed", "survived", "timeout", "error", "uncovered" or "equivalent".
    public var outcome: String
    public var durationMs: Double?
    public var testCount: Int?
    public var evidence: String
}

public struct MutationExecution: Codable, Sendable, Equatable {
    public var baselines: [BaselineResult]
    public var positiveControls: [MutantResult]?
    public var mutants: [MutantResult]
    public var planned: Int?
}

public struct MutationSummary: Codable, Sendable, Equatable {
    public var killed: Int
    public var survived: Int
    public var timeouts: Int
    public var errors: Int
    public var uncovered: Int
    public var equivalent: Int
    public var valid: Int
    public var killRate: Double?
    /// "strong", "mixed", "weak" or "inconclusive".
    public var verdict: String
    public var notes: [String]
}

public struct MutationFinding: Codable, Sendable, Equatable, Hashable {
    public var mutantId: String
    public var path: String
    public var line: Int
    public var title: String
    public var detail: String
    public var severity: String
    public var suggestion: String
}

public struct MutationRun: Codable, Sendable, Equatable {
    public var id: String
    public var headSha: String
    /// "running", "succeeded", "failed" or "cancelled".
    public var status: String
    /// "copying", "planning", "baseline", "control", "mutants", "explaining" or "done".
    public var phase: String
    public var execution: MutationExecution?
    public var summary: MutationSummary?
    public var findings: [MutationFinding]?
    public var error: String?
    public var costUsd: Double?
    public var startedAt: String
    public var finishedAt: String?
    public var isCurrentHead: Bool
    public var live: Bool
}

public struct MutationTestingState: Codable, Sendable, Equatable {
    public struct Blocked: Codable, Sendable, Equatable {
        public var reason: String
        /// The repo has no setup script, so starting means agreeing to run the PR's tests as they are.
        public var needsTestConfirmation: Bool?
    }

    public var run: MutationRun?
    public var headSha: String?
    public var blocked: Blocked?
    public var sandboxNotes: String
}

public struct StartedMutation: Codable, Sendable, Equatable {
    public var runId: String
    public var existing: Bool
}

public struct MutationTestingConfig: Codable, Sendable, Equatable {
    public var planningModel: String?
    public var planningBudgetUsd: Double
    public var explanationModel: String?
    public var explanationBudgetUsd: Double
    public var maxMutants: Int
    public var testTimeoutCapSeconds: Int

    /// What the tab shows when the config can't be read.
    public static let defaults = MutationTestingConfig(
        planningModel: "sonnet", planningBudgetUsd: 1, explanationModel: "sonnet", explanationBudgetUsd: 0.5,
        maxMutants: 12, testTimeoutCapSeconds: 300)
}

/// One event of a mutation pass (`…/mutation-testing/progress`). Replay
/// repeats results, so whoever folds them upserts by id.
public enum MutationProgressEvent: Sendable, Equatable {
    case phase(String, agentRunId: String?)
    /// `phase` is "planning" or "explaining".
    case agent(phase: String, event: AgentRunEvent)
    case baseline(BaselineResult)
    case mutant(MutantResult, index: Int, total: Int, control: Bool)
    case error(String)
    case done(status: String)

    public static func decode(_ json: Data) throws -> MutationProgressEvent {
        let decoder = JSONDecoder()
        let v = try decoder.decode(JSONValue.self, from: json)
        func field<T: Decodable>(_ type: T.Type, _ key: String) throws -> T {
            guard let raw = v[key] else { throw YarvisError.badResponse }
            return try decoder.decode(T.self, from: JSONEncoder().encode(raw))
        }
        switch v["type"]?.stringValue {
        case "phase": return .phase(v["phase"]?.stringValue ?? "", agentRunId: v["agentRunId"]?.stringValue)
        case "agent":
            guard let event = v["event"] else { throw YarvisError.badResponse }
            return .agent(phase: v["phase"]?.stringValue ?? "", event: try AgentRunEvent.decode(event))
        case "baseline": return .baseline(try field(BaselineResult.self, "result"))
        case "mutant":
            return .mutant(try field(MutantResult.self, "result"), index: try field(Int.self, "index"),
                           total: try field(Int.self, "total"), control: (try? field(Bool.self, "control")) ?? false)
        case "error": return .error(v["message"]?.stringValue ?? "")
        case "done": return .done(status: v["status"]?.stringValue ?? "")
        default: throw YarvisError.badResponse
        }
    }
}

// MARK: What the report says about a file

/// What each check is called, in the report, on the diff and in drafted comments.
public let verificationCheckLabels: [String: String] = [
    "malice": "Malicious intent",
    "tests": "Test quality",
    "complexity": "Complexity",
    "performance": "Performance",
    "comments": "Comment quality",
    "observability": "Observability",
    "quality": "Code quality",
]

public let claimStatusLabels: [String: String] = [
    "verified": "Verified",
    "partial": "Partial",
    "missing": "Missing",
    "contradicted": "Contradicted",
    "unverifiable": "Can't tell",
]

/// A claim the code doesn't fully meet.
public func isUnmetClaim(_ status: String) -> Bool {
    ["partial", "missing", "contradicted"].contains(status)
}

/// One thing the report says about a line of a file. Model-written, so
/// shown as plain text.
public struct FileNote: Sendable, Equatable, Hashable {
    /// The check that raised it, "Risk", "Unfinished work", "Claim …", or
    /// "Looks off" for a must-read's flag.
    public var source: String
    public var title: String
    public var detail: String?
    public var severity: String?
    public var line: Int

    /// The hover text for the line it marks.
    public var hoverText: String {
        let severity = severity.map { " (\($0))" } ?? ""
        return "\(source)\(severity): \(title)\(detail.map { ". \($0)" } ?? "")"
    }
}

/// The report's findings, risk concerns, unmet claims and must-read flags
/// that cite a line of `path`, in line order. One with no line stays in the
/// report alone.
public func fileNotes(_ report: VerificationReport?, path: String) -> [FileNote] {
    guard let report else { return [] }
    var notes: [FileNote] = []
    for flag in report.mustRead?.first(where: { $0.path == path })?.flags ?? [] {
        if let line = flag.line, line > 0 { notes.append(FileNote(source: "Looks off", title: flag.note, line: line)) }
    }
    for c in report.risk?.concerns ?? [] where c.path == path {
        if let line = c.line, line > 0 { notes.append(FileNote(source: "Risk", title: c.title, detail: c.detail, line: line)) }
    }
    for c in report.claims?.items ?? [] where c.path == path && isUnmetClaim(c.status) {
        if let line = c.line, line > 0 {
            let label = (claimStatusLabels[c.status] ?? c.status).lowercased()
            notes.append(FileNote(source: "Claim \(label)", title: c.claim, detail: c.evidence, line: line))
        }
    }
    for g in report.claims?.gaps ?? [] where g.path == path {
        if let line = g.line, line > 0 {
            notes.append(FileNote(source: "Unfinished work", title: g.title, detail: g.detail, severity: g.severity,
                                  line: line))
        }
    }
    for key in VerificationSections.checks {
        for f in report.check(key)?.findings ?? [] where f.path == path {
            if let line = f.line, line > 0 {
                notes.append(FileNote(source: verificationCheckLabels[key] ?? key, title: f.title, detail: f.detail,
                                      severity: f.severity, line: line))
            }
        }
    }
    // Stable, so notes on one line keep the order above.
    return notes.enumerated().sorted { ($0.element.line, $0.offset) < ($1.element.line, $1.offset) }.map(\.element)
}
