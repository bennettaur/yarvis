import Foundation
import Testing
@testable import YarvisClient

private func desc(_ prId: String = "a") -> ReviewTabSpec { ReviewTabSpec(kind: .description, prId: prId) }
private func comments(_ prId: String = "a") -> ReviewTabSpec { ReviewTabSpec(kind: .comments, prId: prId) }
private func diff(_ path: String, _ prId: String = "a", line: Int? = nil) -> ReviewTabSpec {
    .diff(prId: prId, path: path, revealLine: line)
}

private func ids(_ layout: ReviewTabLayout, _ group: Int = 0) -> [String] { layout.groups[group].tabs.map(\.id) }
private func open(_ specs: ReviewTabSpec...) -> ReviewTabLayout {
    specs.reduce(ReviewTabLayout.empty) { $0.opening($1) }
}

@Suite struct ReviewLayoutOpenTests {
    @Test func opensATabOnceAndFocusesItWhenAskedAgain() {
        let layout = open(desc(), diff("x.ts")).opening(desc())
        #expect(ids(layout) == ["description:a", "diff:a:x.ts"])
        #expect(layout.groups[0].activeId == "description:a")
    }

    @Test func aSinceFileReopenedFromANewerReviewComparesFromThatOne() {
        let since = { (from: String) in ReviewTabSpec.sinceFile(prId: "a", path: "x.ts", from: from) }
        let layout = open(since(String(repeating: "a", count: 40)), desc(), since(String(repeating: "b", count: 40)))
        #expect(ids(layout) == ["description:a", "since-file:a:x.ts"])
        #expect(layout.groups[0].tabs[1] == since(String(repeating: "b", count: 40)))
    }

    @Test func keepsStaticTabsLeftInAFixedOrder() {
        let layout = open(diff("b.ts"), comments(), diff("a.ts"), desc(), desc("b"))
        #expect(ids(layout) == ["description:a", "description:b", "comments:a", "diff:a:b.ts", "diff:a:a.ts"])
    }

    @Test func handsANewLineToAnOpenFileWithANewNonceEachTime() {
        let once = open(diff("x.ts"), desc()).opening(diff("x.ts", line: 42))
        #expect(once.activeTab?.revealLine == 42)
        #expect(once.activeTab?.revealNonce == 1)
        #expect(ids(once).count == 2)
        let twice = once.opening(diff("x.ts", line: 42))
        #expect(twice.activeTab?.revealNonce == 2)
        // Opening without a line keeps where the tab was.
        #expect(twice.opening(diff("x.ts")).activeTab == twice.activeTab)
    }

    @Test func focusesATabOpenInTheOtherGroup() {
        var split = open(desc(), diff("x.ts")).movingActiveToOtherGroup()
        split.focusedGroup = 0
        let back = split.opening(diff("x.ts"))
        #expect(back.groups.count == 2)
        #expect(back.focusedGroup == 1)
        #expect(ids(back, 1) == ["diff:a:x.ts"])
    }

    @Test func keepsOneClaudeTabWhicheverPrOpensIt() {
        let layout = open(desc("a"), ReviewTabSpec(kind: .claude, prId: "a"), ReviewTabSpec(kind: .claude, prId: "b"))
        #expect(ids(layout) == ["description:a", "claude"])
        #expect(layout.groups[0].activeId == "claude")
    }

    @Test func createsTheSecondGroupWhenAskedForOne() {
        let layout = open(desc()).opening(diff("x.ts"), group: 1)
        #expect(layout.groups.map(\.key) == ["a", "b"])
        #expect(ids(layout, 1) == ["diff:a:x.ts"])
    }
}

@Suite struct ReviewLayoutCloseTests {
    @Test func showsTheRightNeighbourOrTheLeftAtTheEnd() {
        let layout = open(diff("1"), diff("2"), diff("3"))
        #expect(layout.opening(diff("2")).closing("diff:a:2").groups[0].activeId == "diff:a:3")
        #expect(layout.closing("diff:a:3").groups[0].activeId == "diff:a:2")
    }

    @Test func foldsTheSplitWhenAGroupsLastTabCloses() {
        let folded = open(desc(), diff("x.ts")).movingActiveToOtherGroup().closing("diff:a:x.ts")
        #expect(folded.groups.count == 1)
        #expect(folded.focusedGroup == 0)
        #expect(ids(folded) == ["description:a"])
    }

    @Test func leavesOneEmptyGroupWhenEverythingCloses() {
        #expect(open(desc()).closing("description:a") == .empty)
    }
}

@Suite struct ReviewLayoutSplitTests {
    @Test func movesTheShowingTabToASecondGroup() {
        let split = open(desc(), diff("x.ts")).movingActiveToOtherGroup()
        #expect(ids(split, 0) == ["description:a"])
        #expect(ids(split, 1) == ["diff:a:x.ts"])
        #expect(split.focusedGroup == 1)
    }

    @Test func wontSplitOffAGroupsOnlyTab() {
        #expect(open(desc()).movingActiveToOtherGroup().groups.count == 1)
    }

    @Test func movesBackFoldingTheEmptiedGroup() {
        let back = open(desc(), diff("x.ts")).movingActiveToOtherGroup().movingActiveToOtherGroup()
        #expect(back.groups.count == 1)
        #expect(ids(back) == ["description:a", "diff:a:x.ts"])
    }

    @Test func landsInTheRightGroupWhenTheSourceFolds() {
        let split = open(desc(), diff("x.ts")).movingActiveToOtherGroup()
        let moved = split.moving("diff:a:x.ts", toGroup: 0)
        #expect(ids(moved) == ["description:a", "diff:a:x.ts"])
        #expect(moved.groups[0].key == split.groups[0].key)
        var back = open(diff("1"), diff("2")).movingActiveToOtherGroup()
        back.focusedGroup = 0
        let folded = back.moving("diff:a:1", toGroup: 1)
        #expect(folded.groups.count == 1)
        #expect(ids(folded) == ["diff:a:2", "diff:a:1"])
        #expect(folded.focusedGroup == 0)
    }

    @Test func dropsAMovedTabBeforeTheTabItWasDroppedOn() {
        let split = open(diff("1"), diff("2"), diff("3")).movingActiveToOtherGroup()
        #expect(ids(split.moving("diff:a:1", toGroup: 1, before: "diff:a:3"), 1) == ["diff:a:1", "diff:a:3"])
    }
}

@Suite struct ReviewLayoutCycleTests {
    @Test func cyclesWithinTheFocusedGroup() {
        let layout = open(desc(), diff("1")).movingActiveToOtherGroup().opening(diff("2"))
        #expect(layout.cycling(forward: true).groups[1].activeId == "diff:a:1")
        #expect(layout.cycling(forward: true).groups[0].activeId == "description:a")
        let one = open(diff("1"), diff("2"))
        #expect(one.cycling(forward: true).groups[0].activeId == "diff:a:1")
        #expect(one.cycling(forward: false).groups[0].activeId == "diff:a:1")
    }

    @Test func reordersFilesButKeepsStaticTabsPinned() {
        let layout = open(desc(), diff("1"), diff("2"))
        #expect(ids(layout.reordering(inGroup: 0, "diff:a:2", onto: "diff:a:1", after: false))
            == ["description:a", "diff:a:2", "diff:a:1"])
        #expect(ids(layout.reordering(inGroup: 0, "diff:a:2", onto: "description:a", after: false))
            == ["description:a", "diff:a:2", "diff:a:1"])
    }

    @Test func reorderTabsIsNilForANoOp() {
        #expect(reorderTabs(["a", "b", "c"], "a", onto: "b", after: false) == nil)
        #expect(reorderTabs(["a", "b", "c"], "a", onto: "b", after: true) == ["b", "a", "c"])
        #expect(reorderTabs(["a", "b", "c"], "c", onto: "a", after: false) == ["c", "a", "b"])
        #expect(reorderTabs(["a"], "a", onto: "z", after: false) == nil)
    }
}

@Suite struct ReviewLayoutPruneTests {
    @Test func movesTheClaudeTabToARemainingPr() {
        let layout = open(desc("a"), desc("b"), ReviewTabSpec(kind: .claude, prId: "a")).pruning(keeping: ["b"])
        #expect(ids(layout) == ["description:b", "claude"])
        #expect(layout.groups[0].tabs[1].prId == "b")
        #expect(ids(layout.pruning(keeping: [])) == [])
    }

    @Test func foldsASplitWhoseGroupHeldOnlyTheRemovedPrsTabs() {
        let pruned = open(desc("a"), desc("b")).movingActiveToOtherGroup().pruning(keeping: ["a"])
        #expect(pruned.groups.count == 1)
        #expect(ids(pruned) == ["description:a"])
    }
}

@Suite struct ReviewLayoutSavingTests {
    @Test func roundTripsWithoutLineJumps() {
        var layout = open(desc(), diff("x.ts", line: 12)).movingActiveToOtherGroup()
        layout.ratio = 0.3
        let loaded = ReviewTabLayout.parse(layout.serialized())
        #expect(loaded.groups.map(\.activeId) == ["description:a", "diff:a:x.ts"])
        #expect(loaded.focusedGroup == 1)
        #expect(loaded.ratio == 0.3)
        #expect(loaded.activeTab == diff("x.ts"))
    }

    @Test func keepsWhatIsWellFormedFromADamagedValue() {
        let raw = #"""
        {"groups":[{"activeId":"nope","tabs":[{"kind":"description","prId":"a"},{"kind":"bogus","prId":"a"},
          {"kind":"diff","prId":"a","path":"x"},{"kind":"description","prId":"a"},{"kind":"diff","prId":"a"}]},
          {"tabs":[]}],"focusedGroup":5,"ratio":7}
        """#
        let layout = ReviewTabLayout.parse(Data(raw.utf8))
        #expect(ids(layout) == ["description:a", "diff:a:x"])
        #expect(layout.groups.count == 1)
        #expect(layout.groups[0].activeId == "description:a")
        #expect(layout.focusedGroup == 0)
        #expect(layout.ratio == 0.5)
    }

    @Test func keepsATabStoredInBothGroupsOnlyInTheFirst() {
        let raw = #"""
        {"groups":[{"activeId":"comments:a","tabs":[{"kind":"diff","prId":"a","path":"x"},
          {"kind":"comments","prId":"a"},{"kind":"description","prId":"a"}]},
          {"activeId":"diff:a:x","tabs":[{"kind":"diff","prId":"a","path":"x"},{"kind":"diff","prId":"a","path":"y"}]}]}
        """#
        let layout = ReviewTabLayout.parse(Data(raw.utf8))
        #expect(ids(layout, 0) == ["description:a", "comments:a", "diff:a:x"])
        #expect(ids(layout, 1) == ["diff:a:y"])
        #expect(layout.groups[1].activeId == "diff:a:y")
        #expect(layout.groups.map(\.key) == ["a", "b"])
    }

    @Test func keepsSinceFileAndCommitTabsAndDropsMalformedOnes() {
        let from = String(repeating: "a", count: 40)
        let sha = String(repeating: "b", count: 40)
        let since = ReviewTabSpec.sinceFile(prId: "a", path: "x.ts", from: from)
        let commit = ReviewTabSpec.commit(prId: "a", sha: sha, subject: "Fix it")
        let loaded = ReviewTabLayout.parse(open(desc(), since, commit, ReviewTabSpec(kind: .sinceReview, prId: "a"))
            .serialized())
        #expect(ids(loaded) == ["description:a", "since-review:a", "since-file:a:x.ts", "commit:a:\(sha)"])
        #expect(loaded.groups[0].tabs[2] == since)
        #expect(loaded.groups[0].tabs[3] == commit)
        let damaged = #"""
        {"groups":[{"tabs":[{"kind":"since-file","prId":"a","path":"x.ts","from":"main"},
          {"kind":"commit","prId":"a","sha":"HEAD"},{"kind":"commit","prId":"a","sha":"\#(sha)"}]}]}
        """#
        #expect(ids(ReviewTabLayout.parse(Data(damaged.utf8))) == ["commit:a:\(sha)"])
    }

    @Test func startsEmptyOnAnythingUnreadable() {
        #expect(ReviewTabLayout.parse(Data("{not json".utf8)) == .empty)
        #expect(ReviewTabLayout.parse(Data("[]".utf8)) == .empty)
        #expect(ReviewTabLayout.parse(nil) == .empty)
        #expect(ReviewTabLayout.parse(ReviewTabLayout.empty.serialized()) == .empty)
    }
}

@Suite struct ReviewShortcutTests {
    typealias P = ReviewShortcut.Press

    @Test func cyclesTabsOnCtrlTabAndCmdOptionArrows() {
        #expect(ReviewShortcut.resolve(P(.tab, control: true)) == .nextTab)
        #expect(ReviewShortcut.resolve(P(.tab, control: true, shift: true)) == .prevTab)
        #expect(ReviewShortcut.resolve(P(.right, command: true, option: true)) == .nextTab)
        #expect(ReviewShortcut.resolve(P(.left, command: true, option: true)) == .prevTab)
        #expect(ReviewShortcut.resolve(P(.tab)) == nil)
    }

    @Test func closesSplitsAndStepsFiles() {
        #expect(ReviewShortcut.resolve(P(.character("w"), command: true)) == .closeTab)
        #expect(ReviewShortcut.resolve(P(.character("w"), command: true, shift: true)) == nil)
        #expect(ReviewShortcut.resolve(P(.character("\\"), command: true)) == .otherGroup)
        #expect(ReviewShortcut.resolve(P(.character("j"), option: true)) == .nextFile)
        #expect(ReviewShortcut.resolve(P(.character("k"), option: true)) == .prevFile)
        #expect(ReviewShortcut.resolve(P(.character("j"), command: true, option: true)) == nil)
    }

    @Test func onlyTabCyclingWorksWhileTyping() {
        #expect(ReviewShortcut.closeTab.yieldsToTextEntry)
        #expect(ReviewShortcut.nextFile.yieldsToTextEntry)
        #expect(!ReviewShortcut.nextTab.yieldsToTextEntry)
        #expect(!ReviewShortcut.otherGroup.yieldsToTextEntry)
    }
}
