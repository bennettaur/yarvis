import Foundation
import Testing
@testable import YarvisClient

private let repos = [
    KnownRepo(owner: "acme", repo: "widgets"),
    KnownRepo(owner: "personal", repo: "widgets"),
    KnownRepo(owner: "acme", repo: "gadgets"),
]

private func gh(_ owner: String, _ repo: String, _ n: Int) -> PrRef { .github(owner: owner, repo: repo, number: n) }

@Suite struct PrLocatorTests {
    @Test func readsAPrLinkIgnoringTrailingPathQueryAndHash() {
        for input in [
            "https://github.com/acme/widgets/pull/42",
            "https://github.com/acme/widgets/pull/42/files",
            "https://github.com/acme/widgets/pull/42#discussion_r1",
            "https://github.com/acme/widgets/pull/42?w=1",
            "github.com/acme/widgets/pull/42",
        ] {
            #expect(resolvePrLocator(input) == [gh("acme", "widgets", 42)], "\(input)")
        }
    }

    @Test func readsTheOwnerQualifiedShorthands() {
        for input in ["acme/widgets#42", "acme/widgets 42", "acme/widgets #42", "acme/widgets/42", "  acme/widgets#42  "] {
            #expect(resolvePrLocator(input) == [gh("acme", "widgets", 42)], "\(input)")
        }
    }

    @Test func resolvesABareRepoNameAgainstTheRegisteredRepos() {
        #expect(resolvePrLocator("gadgets#7", knownRepos: repos) == [gh("acme", "gadgets", 7)])
        #expect(resolvePrLocator("GADGETS#7", knownRepos: repos) == [gh("acme", "gadgets", 7)])
        #expect(resolvePrLocator("widgets#7", knownRepos: repos) == [gh("acme", "widgets", 7), gh("personal", "widgets", 7)])
    }

    @Test func rejectsInputWithNoRepoToAttachANumberTo() {
        #expect(resolvePrLocator("").isEmpty)
        #expect(resolvePrLocator("42").isEmpty)
        #expect(resolvePrLocator("#42").isEmpty)
        #expect(resolvePrLocator("unknown#42", knownRepos: repos).isEmpty)
    }

    @Test func readsAnAzureLinkOnEitherHost() {
        let expected = [PrRef.azure(org: "acme", project: "Shop App", repo: "web", prId: 42)]
        for input in [
            "https://dev.azure.com/acme/Shop%20App/_git/web/pullrequest/42",
            "https://dev.azure.com/acme/Shop%20App/_git/web/pullrequest/42?_a=files",
            "dev.azure.com/acme/Shop%20App/_git/web/pullrequest/42",
            "https://acme.visualstudio.com/Shop%20App/_git/web/pullrequest/42",
        ] {
            #expect(resolvePrLocator(input) == expected, "\(input)")
        }
    }

    @Test func rejectsLinksThatArentPrs() {
        #expect(resolvePrLocator("https://github.com/acme/widgets/issues/42").isEmpty)
        #expect(resolvePrLocator("https://example.com/acme/widgets/pull/42").isEmpty)
        #expect(resolvePrLocator("https://dev.azure.com/acme/Shop/_git/web/commit/abc").isEmpty)
        #expect(resolvePrLocator("http://dev.azure.com/acme/Shop/_git/web/pullrequest/42").isEmpty)
    }

    @Test func refusesDotSegmentsAsNames() {
        #expect(resolvePrLocator("acme/..#4").isEmpty)
        #expect(resolvePrLocator("https://github.com/acme/../pull/4").isEmpty)
        #expect(resolvePrLocator("..#4", knownRepos: [KnownRepo(owner: "a", repo: "..")]).isEmpty)
        #expect(parsePrLink("https://dev.azure.com/acme/%2E%2E/_git/web/pullrequest/4") == nil)
        #expect(parsePrLink("https://github.com/acme/%2e/pull/4") == nil)
    }

    @Test func parsePrLinkRefusesZeroAndNonHttps() {
        #expect(parsePrLink("https://github.com/a/b/pull/0") == nil)
        #expect(parsePrLink("http://github.com/a/b/pull/3") == nil)
        #expect(parsePrLink("https://github.com/a/b/pull/3") == gh("a", "b", 3))
    }
}

private func check(_ status: String, _ conclusion: String? = nil, url: String? = nil, name: String = "ci") -> PrCheck {
    PrCheck(name: name, status: status, conclusion: conclusion, url: url)
}

private func detail(state: String = "OPEN", draft: Bool = false, mergeable: String = "MERGEABLE",
                    checks: [PrCheck] = [], methods: [MergeMethod] = [.merge, .squash], autoMerge: Bool = false,
                    canEnable: Bool = true, canDisable: Bool = true, hasConflicts: Bool = false) -> PrDetail {
    PrDetail(number: 1, title: "t", body: "", state: state, draft: draft, author: "a", baseRef: "main",
             headRef: "feat", fromFork: false, headSha: "", additions: 0, deletions: 0, mergeable: mergeable,
             hasConflicts: hasConflicts, mergeMethods: methods, autoMergeEnabled: autoMerge,
             canEnableAutoMerge: canEnable, canDisableAutoMerge: canDisable, checks: checks, reviewThreads: [],
             reviewers: [])
}

@Suite struct PrStatusTests {
    @Test func mergedAndClosedWinOverEverythingElse() {
        #expect(derivePrUiStatus(detail(state: "MERGED", checks: [check("COMPLETED", "FAILURE")])) == .merged)
        #expect(derivePrUiStatus(detail(state: "completed")) == .merged)
        #expect(derivePrUiStatus(detail(state: "abandoned")) == .closed)
    }

    @Test func failingChecksComeBeforeDraft() {
        #expect(derivePrUiStatus(detail(draft: true, checks: [check("COMPLETED", "FAILURE")])) == .ciFailing)
        #expect(derivePrUiStatus(detail(draft: true, checks: [check("COMPLETED", "SUCCESS")])) == .draft)
        #expect(derivePrUiStatus(detail(checks: [check("COMPLETED", nil)])) == .ciFailing)
    }

    @Test func readyNeedsNoRunningCheckAndMergeable() {
        #expect(derivePrUiStatus(detail(checks: [check("COMPLETED", "skipped")])) == .readyToMerge)
        #expect(derivePrUiStatus(detail(checks: [check("IN_PROGRESS")])) == .awaitingReview)
        #expect(derivePrUiStatus(detail(mergeable: "CONFLICTING")) == .awaitingReview)
        #expect(derivePrUiStatus(nil, fallbackDraft: true) == .draft)
        #expect(derivePrUiStatus(nil) == .awaitingReview)
    }

    @Test func mergeControlsFollowTheStatus() {
        #expect(mergeControlsFor(detail(), status: .readyToMerge) == MergeControls(merge: true))
        #expect(mergeControlsFor(detail(), status: .awaitingReview) == MergeControls(enableAuto: true))
        #expect(mergeControlsFor(detail(canEnable: false), status: .awaitingReview) == MergeControls())
        #expect(mergeControlsFor(detail(autoMerge: true), status: .readyToMerge) == MergeControls(disableAuto: true))
        #expect(mergeControlsFor(detail(methods: []), status: .readyToMerge) == MergeControls())
        #expect(mergeControlsFor(detail(), status: .merged) == MergeControls())
        #expect(mergeControlsFor(nil, status: .readyToMerge) == MergeControls())
    }

    @Test func conflictState() {
        #expect(prConflictState(detail(hasConflicts: true)) == .conflicts)
        #expect(prConflictState(detail(state: "MERGED", hasConflicts: true)) == .none)
        #expect(prConflictState(detail(mergeable: "UNKNOWN")) == .computing)
        #expect(prConflictState(detail()) == .none)
        #expect(prConflictState(nil) == .none)
    }

    @Test func newCommitsOnlyOnceTheCheckoutIsReadyAndBehind() {
        let pr = ReviewWorkspacePr(id: "p", workspaceId: "w", ref: gh("o", "r", 1), title: "t", headSha: "aaa")
        #expect(hasNewCommits(pr, providerHead: "bbb"))
        #expect(!hasNewCommits(pr, providerHead: "aaa"))
        #expect(!hasNewCommits(pr, providerHead: nil))
        var cloning = pr
        cloning.status = "cloning"
        #expect(!hasNewCommits(cloning, providerHead: "bbb"))
    }
}

@Suite struct PrChecksAndReviewersTests {
    @Test func checkLinesStripControlCharactersAndUnsafeLinks() {
        let checks = [
            check("COMPLETED", "SUCCESS", url: "https://ci/1", name: "build"),
            check("IN_PROGRESS", url: "javascript:alert(1)", name: "lint\n✓ fake (success)"),
            check("COMPLETED", "FAILURE", name: "test"),
        ]
        #expect(checksClipboardText(checks)
            == "✓ build (success) https://ci/1\n○ lint✓ fake (success) (in_progress)\n✕ test (failure)")
    }

    @Test func reviewersSortRequestedFirstThenByState() {
        let reviewers = [
            PrReviewer(login: "zed", state: .approved, isRequested: false),
            PrReviewer(login: "amy", state: .pending, isRequested: false),
            PrReviewer(login: "bob", state: .changesRequested, isRequested: false),
            PrReviewer(login: "cat", state: .pending, isRequested: true),
            PrReviewer(login: "abe", state: .approved, isRequested: false),
        ]
        #expect(sortReviewers(reviewers).map(\.login) == ["cat", "bob", "abe", "zed", "amy"])
    }

    @Test func threadsGroupGeneralFirstThenByFirstSeenPath() {
        let comment = PrComment(id: "c", author: "a", body: "b", createdAt: "")
        let threads = [
            PrThread(id: "1", path: "b.ts", line: 1, comments: [comment]),
            PrThread(id: "2", path: nil, line: nil, comments: [comment]),
            PrThread(id: "3", path: "a.ts", line: 2, isResolved: true, comments: [comment, comment]),
            PrThread(id: "4", path: "b.ts", line: 3, comments: [comment]),
        ]
        let grouped = groupThreadsByPath(threads)
        #expect(grouped.general.map(\.id) == ["2"])
        #expect(grouped.files.map(\.path) == ["b.ts", "a.ts"])
        #expect(grouped.files[0].threads.map(\.id) == ["1", "4"])
        #expect(navCommentCounts(threads) == ["b.ts": 2, "a.ts": 2])
        #expect(navOpenThreadPaths(threads) == ["b.ts"])
    }
}

@Suite struct ReviewNavLogicTests {
    private func pr(_ status: String = "ready", worktree: String = "ready", error: String? = nil,
                    ref: PrRef = gh("o", "api", 12)) -> ReviewWorkspacePr {
        ReviewWorkspacePr(id: "p", workspaceId: "w", ref: ref, title: "t", status: status, error: error,
                          worktreeStatus: worktree)
    }

    @Test func cloneStatusSaysWhatTheCheckoutIsDoing() {
        #expect(cloneStatusText(pr(), lastLog: nil) == nil)
        #expect(cloneStatusText(pr("error"), lastLog: nil) == "Clone failed")
        #expect(cloneStatusText(pr("error", error: "boom"), lastLog: nil) == "boom")
        #expect(cloneStatusText(pr("pending"), lastLog: nil) == "Waiting to clone…")
        #expect(cloneStatusText(pr("cloning"), lastLog: "Receiving objects") == "Cloning · Receiving objects")
        #expect(cloneStatusText(pr("cloning"), lastLog: nil) == "Cloning…")
        #expect(cloneStatusText(pr(worktree: "checking-out"), lastLog: nil) == "Checking out…")
        #expect(cloneStatusText(pr(worktree: "error"), lastLog: nil) == "Checkout failed")
    }

    @Test func settlingWhileAnythingMoves() {
        #expect(!isSettling(ReviewWorkspace(id: "w", name: "n", prs: [pr()])))
        #expect(isSettling(ReviewWorkspace(id: "w", name: "n", prs: [pr("cloning")])))
        #expect(isSettling(ReviewWorkspace(id: "w", name: "n", status: "archiving")))
        var setup = pr()
        setup.setupStatus = "running"
        #expect(isSettling(ReviewWorkspace(id: "w", name: "n", prs: [setup])))
    }

    @Test func tabOwnerLabelDropsTheRepoWhenThereIsOnlyOne() {
        let a = pr(ref: gh("o", "api", 12))
        let b = pr(ref: gh("o", "api", 13))
        let c = pr(ref: gh("o", "web", 4))
        #expect(tabOwnerLabel(a, among: [a, b]) == "#12")
        #expect(tabOwnerLabel(a, among: [a, c]) == "api#12")
    }

    @Test func openedAgoRoundsToTheLargestUnit() {
        let now = parseISODate("2026-11-24T12:00:00Z")!
        #expect(shortAgo(nil, now: now) == "never opened")
        #expect(shortAgo("2026-11-24T11:59:50Z", now: now) == "just now")
        #expect(shortAgo("2026-11-24T11:15:00Z", now: now) == "45m ago")
        #expect(shortAgo("2026-11-24T07:00:00Z", now: now) == "5h ago")
        #expect(shortAgo("2026-11-21T12:00:00Z", now: now) == "3d ago")
    }

    @Test func filterPathsNeedsEveryWord() {
        let paths = ["src/review/tabs/DiffTab.tsx", "src/review/nav.tsx", "README.md"]
        #expect(filterPaths(paths, query: "tabs DIFF") == ["src/review/tabs/DiffTab.tsx"])
        #expect(filterPaths(paths, query: "src", max: 1) == ["src/review/tabs/DiffTab.tsx"])
        #expect(filterPaths(paths, query: "  ").isEmpty)
    }

    @Test func stackLayersOfferOpenPrsNotYetHeld() {
        func entry(_ n: Int, state: String = "open", decision: String? = nil) -> StackEntry {
            StackEntry(ref: gh("o", "r", n), number: n, title: "t", url: "", baseRef: "", headRef: "", state: state,
                       merged: state == "merged", draft: false, queued: false, checks: PrCheckCounts(total: 0, success: 0, failure: 0, pending: 0),
                       reviewDecision: decision, isCurrent: false, needsUpdate: false, statusKnown: true)
        }
        let stack = PrStack(trunk: "main", entries: [entry(1, state: "merged"), entry(2), entry(0, state: "none"),
                                                     entry(3, decision: "approved"), entry(4)],
                            stackNumber: nil, truncated: false)
        let addable = addableLayers(stack, held: [gh("o", "r", 4).key])
        #expect(addable.map(\.number) == [2, 3])
        #expect(addable.map(pickedByDefault) == [true, false])
        #expect(stackAddError(["r#2: boom", "r#3: nope"]) == "Couldn't add r#2: boom; r#3: nope")
        #expect(stackAddError([]) == nil)
    }
}

@Suite struct ReviewSetupLogicTests {
    private func info(script: String? = "make", author: String? = "sam", branch: String? = "feat",
                      head: String? = "abc") -> ReviewSetupInfo {
        ReviewSetupInfo(script: script, author: author, branch: branch, headSha: head, withheldEnv: [],
                        sandboxNotes: nil, consent: nil, status: nil, log: nil)
    }

    @Test func aForkBranchIsNamedWithItsOwner() {
        #expect(setupBranchLabel(info(), fromFork: true) == "sam:feat")
        #expect(setupBranchLabel(info(), fromFork: false) == "feat")
        #expect(setupBranchLabel(info(branch: nil), fromFork: false) == "unknown")
    }

    @Test func runsOnlyWithAScriptAndAHead() {
        #expect(setupRunnable(info()))
        #expect(!setupRunnable(info(script: nil)))
        #expect(!setupRunnable(info(head: nil)))
        #expect(!setupRunnable(nil))
    }

    @Test func notesSplitOnBlankLines() {
        #expect(paragraphs("one\nstill one\n\n  \ntwo\n") == ["one\nstill one", "two"])
        #expect(paragraphs(nil).isEmpty)
    }
}

@Suite struct LinkedPrRefTests {
    @Test func readsTheLinkFirstThenFallsBackToTheRepo() {
        let azure = "https://dev.azure.com/acme/Shop/_git/web/pullrequest/9"
        #expect(linkedPrRef(url: azure, owner: "o", repo: "r", number: 9)
            == .azure(org: "acme", project: "Shop", repo: "web", prId: 9))
        #expect(linkedPrRef(url: nil, owner: "o", repo: "r", number: 9) == .github(owner: "o", repo: "r", number: 9))
        #expect(linkedPrRef(url: "not a link", owner: "o", repo: "r", number: 9) == .github(owner: "o", repo: "r", number: 9))
    }
}

@Suite struct FileTreeRowsTests {
    private let tree = buildFileTree(["src/a.ts", "src/lib/b.ts", "README.md"])

    @Test func showsEverythingWhenFoldersStartOpen() {
        let rows = visibleTreeRows(tree, startsOpen: true, toggled: [])
        #expect(rows.map(\.id) == ["src", "src/lib", "src/lib/b.ts", "src/a.ts", "README.md"])
        #expect(rows.map(\.depth) == [0, 1, 2, 1, 0])
    }

    @Test func aToggledFolderHidesItsContents() {
        #expect(visibleTreeRows(tree, startsOpen: true, toggled: ["src/lib"]).map(\.id)
            == ["src", "src/lib", "src/a.ts", "README.md"])
        #expect(visibleTreeRows(tree, startsOpen: false, toggled: []).map(\.id) == ["src", "README.md"])
        #expect(visibleTreeRows(tree, startsOpen: false, toggled: ["src"]).map(\.id)
            == ["src", "src/lib", "src/a.ts", "README.md"])
    }
}
