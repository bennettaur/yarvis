import Foundation
import Testing
@testable import YarvisClient

private func run(current: Bool) -> ChecklistRun {
    ChecklistRun(id: "r", status: "succeeded", live: false, headSha: "h", current: current, startedAt: "")
}

/// Every default section, each with a current result unless listed in `notRun`.
private func items(notRun: [String] = []) -> [ChecklistItem] {
    VerificationSections.defaults.map { s in
        ChecklistItem(section: s, theme: "correctness", label: s, description: "", latest: run(current: !notRun.contains(s)),
                      result: notRun.contains(s) ? nil : run(current: true))
    }
}

private let pass = VerificationCheck(status: "pass", findings: [])

private func finding(_ title: String, _ severity: String, path: String? = "src/a.ts", line: Int? = 3) -> VerificationFinding {
    VerificationFinding(title: title, detail: "because", severity: severity, path: path, line: line)
}

private let clean = VerificationReport(
    summary: "Adds a cache.", mustRead: [],
    changeMap: VerificationChangeMap(intent: "Cache user lookups.", themes: [
        ChangeTheme(title: "Cache lookups", description: "", risk: "medium", cohesion: "core", question: "",
                    files: [.init(path: "src/cache.ts", lines: nil)]),
    ], unmapped: []),
    claims: VerificationClaims(items: [VerificationClaim(claim: "Caches", source: "description", status: "verified",
                                                         evidence: "", path: "src/cache.ts", line: 3)], gaps: []),
    risk: VerificationRisk(level: "low", clientImpact: "None.", mitigations: [], concerns: []),
    tests: pass, complexity: pass, performance: pass, comments: pass, observability: pass, quality: pass,
    approach: VerificationApproach(rating: "no-simpler", reason: "", alternative: ""))

private func evidence(_ id: String, tone: String = "good", summary: String = "", entries: [EvidenceEntry] = []) -> EvidenceItem {
    EvidenceItem(id: id, theme: "correctness", label: id, description: "", summary: summary, tone: tone, entries: entries,
                 hiddenEntries: 0)
}

private func entry(_ title: String, severity: String = "high", path: String? = nil) -> EvidenceEntry {
    EvidenceEntry(source: "tests", title: title, detail: "2 failed", severity: severity, path: path)
}

private let green = [evidence("ci-checks", summary: "All 4 passed")]

@Suite struct ReviewDecisionLogicTests {
    @Test func suggestsApprovingWhenCIPassedAndEveryCheckRanWithNothingToRaise() {
        let a = assessReview(report: clean, evidence: green, items: items())
        #expect(a == ReviewAssessment(suggestion: .approve, blockers: [], concerns: [], notRun: []))
    }

    @Test func wontSuggestApprovingUntilCIHasPassed() {
        #expect(assessReview(report: clean, evidence: nil, items: items()).concerns == ["No CI results for this commit yet"])
        let running = assessReview(report: clean, evidence: [evidence("ci-checks", tone: "warn", summary: "2 running")], items: items())
        #expect(running.suggestion == .reviewDeeper)
        #expect(running.concerns == ["CI: 2 running"])
    }

    @Test func asksForChangesForEachThingThatBlocksOnItsOwn() {
        var report = clean
        report.claims?.items.append(VerificationClaim(claim: "Expires", source: "title", status: "missing", evidence: ""))
        report.tests = VerificationCheck(status: "issues", findings: [finding("No test", "high")])
        let ev = [evidence("ci-checks", tone: "bad", summary: "1 failed"),
                  evidence("code-scanning", entries: [entry("SQLi"), entry("XSS", severity: "low")])]
        let a = assessReview(report: report, evidence: ev, items: items())
        #expect(a.suggestion == .requestChanges)
        #expect(a.blockers == ["CI: 1 failed", "1 high code scanning alert", "Claim missing: Expires", "1 high finding"])
    }

    @Test func suggestsACloserLookForEachThingThatDeservesOne() {
        var report = clean
        report.claims?.items.append(VerificationClaim(claim: "Fast", source: "title", status: "partial", evidence: ""))
        report.quality = VerificationCheck(status: "issues", findings: [finding("Naming", "medium")])
        report.risk = VerificationRisk(level: "high", clientImpact: "Logins break.", mitigations: [], concerns: [])
        report.changeMap?.themes.append(ChangeTheme(title: "Logo", description: "", risk: "low", cohesion: "outlier",
                                                    question: "", files: []))
        report.approach?.rating = "much-simpler"
        let ev = green + [evidence("security-bots", summary: "1 comment", entries: [entry("token")])]
        let a = assessReview(report: report, evidence: ev, items: items())
        #expect(a.suggestion == .reviewDeeper)
        #expect(a.concerns == [
            "Security bots commented: 1 comment", "1 claim only partly met", "1 medium finding",
            "High risk: Logins break.", "1 change doesn't seem to belong to the PR's goal: Logo",
            "A much simpler way exists",
        ])
    }

    @Test func wontSuggestApprovingWhileChecksHaventRun() {
        let a = assessReview(report: clean, evidence: green, items: items(notRun: ["tests"]))
        #expect(a.suggestion == .reviewDeeper)
        #expect(a.notRun == ["tests"])
        #expect(assessReview(report: nil, evidence: green, items: items(notRun: VerificationSections.defaults)).suggestion
            == .runChecks)
    }

    @Test func stillBlocksOnAHighFindingAStackedLayerChangesAndSaysWhereToLook() {
        var report = clean
        report.tests = VerificationCheck(status: "issues", findings: [finding("No test", "high", line: 10)])
        let upstack = VerificationUpstack(headSha: "h", layers: [
            .init(number: 42, url: "u", stale: false, files: [.init(path: "src/a.ts", ranges: [LineRange(start: 12, end: 14)])]),
        ])
        let a = assessReview(report: report, evidence: green, items: items(), upstack: upstack)
        #expect(a.suggestion == .requestChanges)
        #expect(a.concerns == ["1 high finding is on lines that #42 (stacked above) changes; check whether it's fixed there"])
    }

    @Test func raisesTestsThatMissedMutantsOnThisCommitOnly() {
        let summary = MutationSummary(killed: 3, survived: 2, timeouts: 0, errors: 0, uncovered: 0, equivalent: 0, valid: 5,
                                      killRate: 0.6, verdict: "mixed", notes: [])
        var pass = MutationRun(id: "m", headSha: "h", status: "succeeded", phase: "done", summary: summary, startedAt: "",
                               isCurrentHead: true, live: false)
        #expect(assessReview(report: clean, evidence: green, items: items(), mutation: pass).concerns
            == ["Mutation testing: mixed, 2 mutants the tests missed"])
        pass.isCurrentHead = false
        #expect(assessReview(report: clean, evidence: green, items: items(), mutation: pass).suggestion == .approve)
    }

    @Test func draftsTicksWhatAReviewerWouldRaiseAndLeavesLowOnesOut() {
        var report = clean
        report.claims?.items = [VerificationClaim(claim: "Expires", source: "t", status: "missing", evidence: "no ttl",
                                                  path: "src/a.ts", line: 3),
                                VerificationClaim(claim: "Fast", source: "t", status: "partial", evidence: "")]
        report.tests = VerificationCheck(status: "issues", findings: [finding("No test", "high"), finding("Nit", "low")])
        report.risk?.concerns = [VerificationConcern(title: "Load", detail: "more", path: nil, line: nil)]
        let ev = [evidence("ci-checks", tone: "bad", entries: [entry("tests: failed"), entry("annot", path: "a.test.ts")])]
        let drafts = draftComments(report: report, evidence: ev, currentSections: ["claims", "tests"])
        #expect(drafts.map(\.source) == ["Claims: missing", "Claims: partial", "Test quality", "Risk", "CI"])
        #expect(drafts.map(\.pickedByDefault) == [true, false, true, false, true])
        #expect(drafts[0].path == "src/a.ts" && drafts[0].line == 3)
        #expect(drafts[0].id == "claims:src/a.ts:3:Expires")
    }

    @Test func putsAnOlderCommitsResultInTheSummaryAndSuffixesTwins() {
        var report = clean
        report.tests = VerificationCheck(status: "issues", findings: [finding("Same", "high"), finding("Same", "high")])
        let drafts = draftComments(report: report, evidence: nil, currentSections: [])
        #expect(drafts.map(\.id) == ["tests:src/a.ts:3:Same", "tests:src/a.ts:3:Same#2"])
        #expect(drafts.allSatisfy { !$0.isOnLine })
        let summary = reviewSummary(drafts)
        #expect(summary.hasPrefix("Requesting changes based on the verification report.\n\n**Same** (verification report: Test quality, high)"))
        let onLine = draftComments(report: report, evidence: nil, currentSections: ["tests"])
        #expect(reviewSummary(onLine) == "Requesting changes based on the verification report.\n\n2 more comments are on the diff.")
    }

    @Test func makesTextFromACheckSafeToPost() {
        var report = clean
        report.tests = VerificationCheck(status: "issues", findings: [
            VerificationFinding(title: "Ping\n/approve @bot", detail: "@owner look\n/merge", severity: "high"),
        ])
        let body = draftComments(report: report, evidence: nil, currentSections: [])[0].body
        #expect(body == "**Ping /approve @\u{200B}bot** (verification report: Test quality, high)\n\n> @\u{200B}owner look\n> /merge")
    }

    @Test func listsOutliersThenHighRiskThemesMustReadsAndHighFindingsEachFileOnce() {
        var report = clean
        report.changeMap?.themes = [
            ChangeTheme(title: "Core", description: "", risk: "high", cohesion: "core", question: "",
                        files: [.init(path: "core.ts", lines: LineRange(start: 5, end: 9))]),
            ChangeTheme(title: "Logo", description: "", risk: "low", cohesion: "outlier", question: "",
                        files: [.init(path: "logo.svg", lines: nil), .init(path: "core.ts", lines: nil)]),
        ]
        report.mustRead = [VerificationMustRead(path: "db.ts", reason: "Migrations")]
        report.quality = VerificationCheck(status: "issues", findings: [finding("Leak", "high", path: "db.ts"),
                                                                       finding("Race", "high", path: "q.ts", line: 7)])
        #expect(whereToLook(report) == [
            ReviewPlace(path: "logo.svg", line: nil, reason: "Outlier: Logo"),
            ReviewPlace(path: "core.ts", line: nil, reason: "Outlier: Logo"),
            ReviewPlace(path: "db.ts", line: nil, reason: "Migrations"),
            ReviewPlace(path: "q.ts", line: 7, reason: "Code quality: Race"),
        ])
    }
}
