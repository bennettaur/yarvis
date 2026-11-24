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

    @Test func autoStartsOncePerRangeWithinBudget() {
        let size = RereviewSize(files: 1, changedLines: 1, binary: [], noInterdiff: [], skimmed: [], readBytes: 1,
                                overAgentBudget: false, estimatedCostUsd: 0.1, budgetUsd: 1, overBudget: false)
        var latest = LatestRereview(current: false, size: size)
        #expect(shouldAutoStartRereview(latest, autoStart: true, alreadyStarted: false))
        #expect(!shouldAutoStartRereview(latest, autoStart: false, alreadyStarted: false))
        #expect(!shouldAutoStartRereview(latest, autoStart: true, alreadyStarted: true))
        latest.size?.overBudget = true
        #expect(!shouldAutoStartRereview(latest, autoStart: true, alreadyStarted: false))
    }

    @Test func mutationStateFollowsBothTheStreamAndTheStoredPass() {
        let run = MutationRun(id: "m", headSha: "h", status: "running", phase: "mutants", startedAt: "",
                              isCurrentHead: true, live: true)
        var progress = MutationProgress()
        #expect(MutationTabState(run: run, followId: "m", progress: progress, blocked: false, confirming: false).running)
        progress.streamEnded = true
        let lost = MutationTabState(run: run, followId: "m", progress: progress, blocked: false, confirming: false)
        #expect(!lost.running && lost.lostTrack && !lost.canStart)
        var elsewhere = run
        elsewhere.live = false
        let other = MutationTabState(run: elsewhere, followId: nil, progress: nil, blocked: false, confirming: false)
        #expect(other.runningElsewhere && !other.canStart)
        #expect(!MutationTabState(run: nil, followId: nil, progress: nil, blocked: true, confirming: false).canStart)
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
}
