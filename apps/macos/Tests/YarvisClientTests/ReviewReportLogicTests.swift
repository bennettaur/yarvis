import Foundation
import Testing
@testable import YarvisClient

private func comment(_ id: String, _ verdict: String, resolved: Bool = false) -> RereviewComment {
    RereviewComment(threadId: id, kind: "thread", providerId: id, path: nil, line: nil, resolved: resolved,
                    verdict: verdict, evidence: .init(path: nil, line: nil, note: ""), replySummary: nil, downgradedFrom: nil)
}

private func layer(_ n: Int, stale: Bool = false, ranges: [LineRange]?) -> VerificationUpstack.Layer {
    .init(number: n, url: "u\(n)", stale: stale, files: [.init(path: "a.ts", ranges: ranges)])
}

private func since(rebased: Bool, baseMoved: Bool) -> SinceReview {
    let commit = ReviewCommit(sha: "c", subject: "s", author: "a", date: "", parents: [], isNew: true)
    return SinceReview(fromHeadSha: "f", toHeadSha: "t", fromMergeBase: "", toMergeBase: "", rebased: rebased,
                       baseMoved: baseMoved, mark: ReviewMark(headSha: "f", source: "manual", createdAt: ""),
                       files: [SinceFile(path: "a", status: "added", additions: 1, deletions: 0, binary: false, tooLarge: false)],
                       filesTruncated: false, commits: [commit, commit], removedCommits: [], commitsTruncated: false,
                       rebaseMatchSkipped: false)
}

private func rereviewRun(_ id: String, _ status: String) -> RereviewRun {
    RereviewRun(id: id, status: status, startedAt: "")
}

private func checkRun(current: Bool) -> ChecklistRun {
    ChecklistRun(id: "r", status: "succeeded", live: false, headSha: "h", current: current, startedAt: "")
}

private func guide(_ steps: [PrGuideStep], current: Int = 0) -> PrGuide {
    PrGuide(headSha: "h", steps: steps, currentStep: current, stale: false, createdAt: "")
}

/// The web's fixture for `fileNotes`.
private let notesReport: VerificationReport = {
    var r = VerificationReport()
    r.summary = "Adds a cache."
    r.mustRead = [VerificationMustRead(path: "src/cache.ts", reason: "Eviction")]
    r.risk = VerificationRisk(level: "medium", clientImpact: "Stale profiles.", mitigations: [], concerns: [
        VerificationConcern(title: "No invalidation", detail: "Edits stay stale.", path: "src/cache.ts", line: 22),
        VerificationConcern(title: "Whole-PR concern", detail: "No line."),
    ])
    r.performance = VerificationCheck(status: "issues", findings: [
        VerificationFinding(title: "N+1", detail: "One query per user.", severity: "high", path: "src/cache.ts", line: 9),
        VerificationFinding(title: "Elsewhere", detail: "Other file.", severity: "low", path: "src/b.ts", line: 3),
    ])
    r.observability = VerificationCheck(status: "issues", findings: [
        VerificationFinding(title: "Swallowed error", detail: "catch drops it.", severity: "medium", path: "src/cache.ts"),
    ])
    return r
}()

@Suite struct ReviewReportLogicTests {
    @Test func findingBodyNamesTheReportAndQuotesWhatItSaid() {
        #expect(findingCommentBody(title: "No test", detail: "Line one\nLine two", severity: "high", section: "tests")
            == "**No test** (verification report: tests, high)\n\n> Line one\n> Line two")
        #expect(findingCommentBody(title: "Stale\n/approve  now", detail: "x", severity: nil, section: "Risk")
            .hasPrefix("**Stale /approve now** (verification report: Risk)\n"))
    }

    @Test func changedUpstackNamesTheLayerNearTheLine() {
        let up = VerificationUpstack(headSha: "h", layers: [layer(5, ranges: [LineRange(start: 10, end: 12)])])
        #expect(changedUpstack(up, path: "a.ts", line: 11)?.number == 5)
        #expect(changedUpstack(up, path: "a.ts", line: 15)?.number == 5)
        #expect(changedUpstack(up, path: "a.ts", line: 16) == nil)
        #expect(changedUpstack(up, path: "a.ts", line: nil)?.number == 5)
        let whole = VerificationUpstack(headSha: "h", layers: [layer(6, ranges: nil)])
        #expect(changedUpstack(whole, path: "a.ts", line: 999)?.number == 6)
        let stale = VerificationUpstack(headSha: "h", layers: [layer(7, stale: true, ranges: nil)])
        #expect(changedUpstack(stale, path: "a.ts", line: 1) == nil)
        #expect(changedUpstack(up, path: nil, line: 11) == nil)
        #expect(changedUpstack(nil, path: "a.ts", line: 11) == nil)
    }

    @Test func resultVerdictsReadLikeTheChecklist() {
        var report = VerificationReport()
        #expect(resultVerdict(section: "summary", report: report) == nil)
        report.summary = "s"
        report.mustRead = [VerificationMustRead(path: "a", reason: "r")]
        #expect(resultVerdict(section: "summary", report: report) == ReportChip("1 must-read file", .muted))
        report.claims = VerificationClaims(items: [
            VerificationClaim(claim: "a", source: "t", status: "verified", evidence: ""),
            VerificationClaim(claim: "b", source: "t", status: "contradicted", evidence: ""),
        ], gaps: [])
        #expect(resultVerdict(section: "claims", report: report) == ReportChip("1 of 2 verified", .bad))
        report.changeMap = VerificationChangeMap(intent: "", themes: [], unmapped: ["x"])
        #expect(resultVerdict(section: "changeMap", report: report) == ReportChip("Not mapped", .warn))
        report.tests = VerificationCheck(status: "issues", findings: [
            VerificationFinding(title: "t", detail: "", severity: "medium"),
            VerificationFinding(title: "u", detail: "", severity: "medium"),
        ])
        #expect(resultVerdict(section: "tests", report: report) == ReportChip("2 findings", .warn))
        report.complexity = VerificationCheck(status: "pass", findings: [])
        #expect(resultVerdict(section: "complexity", report: report) == ReportChip("Pass", .good))
        report.approach = VerificationApproach(rating: "much-simpler", reason: "", alternative: "")
        #expect(resultVerdict(section: "approach", report: report) == ReportChip("Much simpler way", .bad))
        report.flow = VerificationFlow(title: "", explanation: "", mermaid: "")
        #expect(resultVerdict(section: "flow", report: report) == ReportChip("Not drawn", .muted))
    }

    @Test func suggestsTheDefaultSectionsWithNoCurrentResultAndNoRun() {
        func item(_ section: String, current: Bool?, running: Bool = false) -> ChecklistItem {
            let r = current.map { ChecklistRun(id: "r", status: "succeeded", live: false, current: $0, startedAt: "") }
            let latest = running ? ChecklistRun(id: "l", status: "running", live: true, current: true, startedAt: "") : r
            return ChecklistItem(section: section, theme: "t", label: section, description: "", latest: latest, result: r)
        }
        let items = [item("summary", current: true), item("risk", current: false), item("tests", current: nil),
                     item("quality", current: nil, running: true), item("flow", current: nil)]
        #expect(suggestedSections(items) == ["risk", "tests"])
    }

    @Test func parsesUpToFiveTickets() {
        #expect(parseNamedTickets(" ABC-1, #45  https://x/y,,a b c d") == ["ABC-1", "#45", "https://x/y", "a", "b"])
        #expect(parseNamedTickets("") == [])
    }

    @Test func fileNoticesCountAndLeaveOutEmptyKinds() {
        let notices = fileNotices(binary: ["a.png"], skimmed: ["bun.lock", "dist/x.js"])
        #expect(notices.map(\.text) == [
            "1 binary file has no diff to read",
            "2 files are bulk (a lockfile, or generated, vendored or minified code) that the agents only skim",
        ])
        #expect(costLine(estimatedUsd: 1.5, budgetUsd: 1, overBudget: true)
            == "Estimated cost: about $1.50, against a budget of $1.00. That's over the budget, and the run won't stop when it reaches it.")
    }

    @Test func sinceReviewLines() {
        let mark = ReviewMark(headSha: "h", source: "provider", createdAt: "")
        #expect(markSourceText(mark, ref: .azure(org: "o", project: "p", repo: "r", prId: 1)) == "in your review on Azure DevOps")
        #expect(sinceSummaryLine(since(rebased: true, baseMoved: true)) == "2 new commits · 1 file changed · rebased onto a newer base")
        #expect(sinceSummaryLine(since(rebased: true, baseMoved: false)).hasSuffix("history rewritten (force-push)"))
        #expect(sinceSummaryLine(since(rebased: false, baseMoved: false)) == "2 new commits · 1 file changed")
    }

    @Test func groupsCommentsWorstFirstAndSettlesResolvedOnes() {
        let comments = [comment("a", "unclear"), comment("b", "not_addressed"), comment("c", "disagreed"),
                        comment("d", "addressed"), comment("e", "partly", resolved: true), comment("f", "partly")]
        let groups = groupRereviewComments(comments)
        #expect(groups.open.map(\.threadId) == ["b", "f", "a"])
        #expect(groups.disagreed.map(\.threadId) == ["c"])
        #expect(groups.addressed.map(\.threadId) == ["d", "e"])
        let resolvedNow = groupRereviewComments(comments) { $0.resolved || $0.threadId == "b" }
        #expect(resolvedNow.open.map(\.threadId) == ["f", "a"])
    }

    @Test func autoStartsOnlyWhenNothingCoversTheRangeAndItsWithinBudget() {
        let size = RereviewSize(files: 1, changedLines: 1, binary: [], noInterdiff: [], skimmed: [], readBytes: 1,
                                overAgentBudget: false, estimatedCostUsd: 0.1, budgetUsd: 1, overBudget: false)
        let fresh = LatestRereview(current: false, size: size)
        #expect(shouldAutoStartRereview(fresh, autoStart: true, alreadyStarted: false))
        #expect(!shouldAutoStartRereview(fresh, autoStart: false, alreadyStarted: false))
        #expect(!shouldAutoStartRereview(fresh, autoStart: true, alreadyStarted: true))
        var overBudget = fresh
        overBudget.size?.overBudget = true
        #expect(!shouldAutoStartRereview(overBudget, autoStart: true, alreadyStarted: false))
        var tooBig = fresh
        tooBig.size?.overAgentBudget = true
        #expect(!shouldAutoStartRereview(tooBig, autoStart: true, alreadyStarted: false))
        var current = fresh
        current.current = true
        #expect(!shouldAutoStartRereview(current, autoStart: true, alreadyStarted: false))
        var covered = fresh
        covered.lastSucceeded = .init(run: rereviewRun("s", "succeeded"), current: true)
        #expect(!shouldAutoStartRereview(covered, autoStart: true, alreadyStarted: false))
        var running = fresh
        running.run = rereviewRun("r", "running")
        #expect(!shouldAutoStartRereview(running, autoStart: true, alreadyStarted: false))
    }

    @Test func rereviewIsReadyWhenTheAgentSaysSoOrNothingItRaisedIsOpen() {
        func review(_ verdict: String, _ changes: [String] = []) -> Rereview {
            Rereview(summary: "", verdict: verdict, verdictReason: "", comments: [],
                     newChanges: changes.map { RereviewChange(path: "a", kind: $0, reason: "") })
        }
        let none = RereviewGroups(open: [], disagreed: [], addressed: [])
        #expect(rereviewReady(review("ready_to_approve", ["needs_review"]),
                              groups: RereviewGroups(open: [comment("a", "partly")], disagreed: [], addressed: [])))
        #expect(rereviewReady(review("needs_another_look", ["minor"]), groups: none))
        #expect(!rereviewReady(review("needs_another_look", ["needs_review"]), groups: none))
        #expect(!rereviewReady(review("needs_another_look"),
                               groups: RereviewGroups(open: [], disagreed: [comment("b", "disagreed")], addressed: [])))
        #expect(!rereviewReady(review("needs_another_look"),
                               groups: RereviewGroups(open: [comment("c", "unclear")], disagreed: [], addressed: [])))
    }

    @Test func followingARunNeedsAStreamAndSaysWhenItRunsElsewhere() {
        let here = AgentRunFollow(startedId: nil, runId: "r", runStatus: "running", runLive: true, streamOpen: true,
                                  streamEnded: false, storedMustRun: true)
        #expect(here.followId == "r" && here.running && !here.runningElsewhere && !here.lostTrack)
        let started = AgentRunFollow(startedId: "s", runId: nil, runStatus: nil, runLive: nil, streamOpen: true,
                                     streamEnded: false, storedMustRun: false)
        #expect(started.followId == "s" && started.running)
        let storedStopped = AgentRunFollow(startedId: "s", runId: "s", runStatus: "succeeded", runLive: true,
                                           streamOpen: true, streamEnded: false, storedMustRun: true)
        #expect(!storedStopped.running)
        let elsewhere = AgentRunFollow(startedId: nil, runId: "r", runStatus: "running", runLive: false, streamOpen: false,
                                       streamEnded: false, storedMustRun: true)
        #expect(elsewhere.followId == nil && elsewhere.runningElsewhere)
        let lost = AgentRunFollow(startedId: nil, runId: "r", runStatus: "running", runLive: true, streamOpen: false,
                                  streamEnded: true, storedMustRun: true)
        #expect(lost.lostTrack && !lost.running)
        var progress = RereviewProgress()
        #expect(rereviewFollow(nil, startedId: "s", progress: progress).running)
        progress.finished = "succeeded"
        #expect(!rereviewFollow(nil, startedId: "s", progress: progress).running)
    }

    @Test func killRateAndChips() {
        var s = MutationSummary(killed: 3, survived: 1, timeouts: 1, errors: 0, uncovered: 0, equivalent: 0, valid: 5,
                                killRate: 0.8, verdict: "strong", notes: [])
        #expect(killRateText(s) == "The tests caught 4 of 5 mutants (80%).")
        let run = MutationRun(id: "m", headSha: "h", status: "succeeded", phase: "done", summary: s, startedAt: "",
                              isCurrentHead: true, live: false)
        #expect(mutationChip(run) == ReportChip("Strong: 3 of 5 mutants caught", .good))
        s.valid = 0
        #expect(killRateText(s) == "No mutant gave a result.")
    }

    @Test func guideStepLocations() {
        var step = PrGuideStep(path: "a.ts", startLine: nil, endLine: nil, explanation: "")
        #expect(guideStepLocation(step) == "a.ts")
        step.startLine = 3
        #expect(guideStepLocation(step) == "a.ts:3")
        step.endLine = 9
        #expect(guideStepLocation(step) == "a.ts:3–9")
    }

    @Test func fileNotesGatherWhatCitesALineFromRiskAndEveryCheckInLineOrder() {
        #expect(fileNotes(notesReport, path: "src/cache.ts") == [
            FileNote(source: "Performance", title: "N+1", detail: "One query per user.", severity: "high", line: 9),
            FileNote(source: "Risk", title: "No invalidation", detail: "Edits stay stale.", line: 22),
        ])
        #expect(fileNotes(nil, path: "src/cache.ts").isEmpty)
    }

    @Test func fileNotesNoteUnmetClaimsAndUnfinishedWorkButNotVerifiedClaims() {
        var r = VerificationReport()
        r.claims = VerificationClaims(items: [
            VerificationClaim(claim: "Caches users", source: "description", status: "verified", evidence: "e", path: "a.ts", line: 2),
            VerificationClaim(claim: "Invalidates", source: "ABC-1", status: "partial", evidence: "only on delete", path: "a.ts", line: 9),
        ], gaps: [VerificationFinding(title: "TODO left", detail: "d", severity: "low", path: "a.ts", line: 5)])
        #expect(fileNotes(r, path: "a.ts") == [
            FileNote(source: "Unfinished work", title: "TODO left", detail: "d", severity: "low", line: 5),
            FileNote(source: "Claim partial", title: "Invalidates", detail: "only on delete", line: 9),
        ])
    }

    @Test func fileNotesAddEachFlagThatCitesALineLabelledApartFromTheReason() {
        var r = notesReport
        r.mustRead = [
            VerificationMustRead(path: "src/cache.ts", reason: "Eviction", flags: [
                .init(note: "TTL is read but never applied", line: 30), .init(note: "No line"),
            ]),
            VerificationMustRead(path: "src/b.ts", reason: "Other", flags: [.init(note: "Flagged in b", line: 5)]),
        ]
        let notes = fileNotes(r, path: "src/cache.ts")
        #expect(notes.first { $0.source == "Looks off" } == FileNote(source: "Looks off", title: "TTL is read but never applied", line: 30))
        #expect(notes.map(\.line) == [9, 22, 30])
        #expect(notes[2].hoverText == "Looks off: TTL is read but never applied")
        #expect(notes[0].hoverText == "Performance (high): N+1. One query per user.")
    }

    @Test func fileNotesTakeFlagsOnlyFromTheFilesOwnMustRead() {
        var r = notesReport
        r.mustRead = [
            VerificationMustRead(path: "src/cache.ts", reason: "Eviction", flags: [.init(note: "TTL", line: 30)]),
            VerificationMustRead(path: "src/b.ts", reason: "Other", flags: [.init(note: "Flagged in b", line: 5)]),
        ]
        #expect(fileNotes(r, path: "src/b.ts").map(\.title) == ["Elsewhere", "Flagged in b"])
        #expect(fileNotes(r, path: "src/none.ts").isEmpty)
    }

    @Test func decisionInputsDropEvidenceAndStacksReadAtAnotherCommit() {
        func item(_ section: String, current: Bool?) -> ChecklistItem {
            ChecklistItem(section: section, theme: "t", label: section, description: "",
                          latest: current.map(checkRun), result: current.map(checkRun))
        }
        let checklist = VerificationChecklist(headSha: "h", themes: [], items: [
            item("summary", current: true), item("risk", current: false), item("tests", current: nil),
        ], namedTickets: [])
        let ci = EvidenceItem(id: "ci-checks", theme: "t", label: "CI", description: "", summary: "", tone: "good",
                              entries: [], hiddenEntries: 0)
        let same = decisionInputs(checklist: checklist, evidence: VerificationEvidence(headSha: "h", items: [ci]),
                                  upstack: VerificationUpstack(headSha: "h", layers: []))
        #expect(same.evidence == [ci])
        #expect(same.upstack != nil)
        #expect(same.currentSections == ["summary"])
        let other = decisionInputs(checklist: checklist, evidence: VerificationEvidence(headSha: "old", items: [ci]),
                                   upstack: VerificationUpstack(headSha: "old", layers: []))
        #expect(other.evidence == nil && other.upstack == nil)
        #expect(decisionInputs(checklist: checklist, evidence: nil, upstack: nil).evidence == nil)
    }

    @Test func runRequestsUseTheSettingsChoiceWhenNothingIsPicked() {
        let defaults = verificationRunRequest(typedTickets: nil, savedTickets: ["ABC-1", "#2"], model: "", effort: "",
                                              harness: "")
        #expect(defaults == VerificationRunRequest(namedTickets: ["ABC-1", "#2"], choice: VerificationRunChoice(), harness: nil))
        let picked = verificationRunRequest(typedTickets: "", savedTickets: ["ABC-1"], model: "opus", effort: "high",
                                            harness: "h2")
        #expect(picked == VerificationRunRequest(namedTickets: [], choice: VerificationRunChoice(model: "opus", effort: "high"),
                                                 harness: "h2"))
    }

    @Test func onlyStartedSectionsAreUntickedAndNoneLeftMeansSuggestions() {
        #expect(pickedAfterStart(["risk", "tests"], started: ["risk"]) == ["tests"])
        #expect(pickedAfterStart(["risk"], started: ["risk"]) == nil)
        #expect(pickedAfterStart(nil, started: ["risk"]) == nil)
        #expect(pickedAfterStart(["risk"], started: []) == ["risk"])
    }

    @Test func guideMovesClampMarkForwardOnlyAndFinishDismisses() {
        let steps = [
            PrGuideStep(path: "a.ts", startLine: 1, endLine: nil, explanation: "", covers: ["b.ts", "a.ts"]),
            PrGuideStep(path: "c.ts", startLine: nil, endLine: nil, explanation: ""),
        ]
        let g = guide(steps)
        #expect(guideMove(g, from: 0, .goTo(9)) == GuideMoveResult(step: 1, markViewed: [], dismiss: false))
        #expect(guideMove(g, from: 1, .goTo(-3)).step == 0)
        #expect(guideMove(g, from: 0, .next) == GuideMoveResult(step: 1, markViewed: ["a.ts", "b.ts"], dismiss: false))
        #expect(guideMove(g, from: 1, .back) == GuideMoveResult(step: 0, markViewed: [], dismiss: false))
        #expect(guideMove(g, from: 1, .finish) == GuideMoveResult(step: 1, markViewed: ["c.ts"], dismiss: true))
        #expect(guideInitialStep(guide(steps, current: 7)) == 1)
        #expect(guideInitialStep(guide(steps, current: -1)) == 0)
        #expect(guideInitialStep(guide([], current: 3)) == 0)
    }

    @Test func fileNotesCollectLinedItemsForThePathInLineOrder() throws {
        let report = try JSONDecoder().decode(VerificationReport.self, from: json(#"""
        {"mustRead":[{"path":"a.ts","reason":"r","flags":[{"note":"odd","line":9},{"note":"no line"}]}],
         "claims":{"items":[{"claim":"c","source":"title","status":"missing","evidence":"e","path":"a.ts","line":2},
                            {"claim":"ok","source":"title","status":"verified","evidence":"e","path":"a.ts","line":3}],
                   "gaps":[]},
         "tests":{"status":"issues","findings":[{"title":"t","detail":"d","severity":"low","path":"a.ts","line":5},
                                                {"title":"x","detail":"d","severity":"low","path":"b.ts","line":1}]}}
        """#))
        let notes = fileNotes(report, path: "a.ts")
        #expect(notes.map(\.source) == ["Claim missing", "Test quality", "Looks off"])
        #expect(notes[1].hoverText == "Test quality (low): t. d")
    }
}
