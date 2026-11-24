import Foundation
import Testing
@testable import YarvisClient

/// A minter at a fixed time, so ids are predictable: `<kind>1<counter>`.
private func minter() -> TerminalUidMinter {
    TerminalUidMinter(now: { Date(timeIntervalSince1970: 0.001) })
}

@Suite struct PaneTreeTests {
    let tree: TerminalPane = .split(.vertical, first: .leaf("a"),
                                    second: .split(.horizontal, first: .leaf("b"), second: .leaf("c"), ratio: 0.3),
                                    ratio: nil)

    @Test func listsLeavesInOrder() {
        #expect(tree.leafIds == ["a", "b", "c"])
        #expect(tree.firstLeafId == "a")
        #expect(tree.contains("c"))
        #expect(!tree.contains("d"))
    }

    @Test func splitPutsTheNewPaneAfterTheTarget() {
        let split = TerminalPane.leaf("a").splitting("a", .vertical, newId: "b")
        #expect(split == .split(.vertical, first: .leaf("a"), second: .leaf("b"), ratio: nil))
        #expect(tree.splitting("b", .vertical, newId: "x").leafIds == ["a", "b", "x", "c"])
        #expect(tree.splitting("missing", .vertical, newId: "x") == tree)
    }

    @Test func removingAPaneCollapsesItsSplit() {
        #expect(tree.removing("b") == .split(.vertical, first: .leaf("a"), second: .leaf("c"), ratio: nil))
        #expect(tree.removing("a") == .split(.horizontal, first: .leaf("b"), second: .leaf("c"), ratio: 0.3))
        #expect(TerminalPane.leaf("a").removing("a") == nil)
        #expect(tree.removing("missing") == tree)
    }

    @Test func setsTheRatioOfTheSplitAtAPath() {
        let changed = tree.settingRatio(at: [.second], 0.7)
        #expect(changed == .split(.vertical, first: .leaf("a"),
                                  second: .split(.horizontal, first: .leaf("b"), second: .leaf("c"), ratio: 0.7),
                                  ratio: nil))
        #expect(tree.settingRatio(at: [.first], 0.7) == tree)
        if case .split(_, _, _, let ratio) = tree.settingRatio(at: [], 5) { #expect(ratio == 0.95) }
    }

    @Test func encodesInTheWebShape() throws {
        let data = try JSONEncoder().encode(TerminalPane.split(.vertical, first: .leaf("a"), second: .leaf("b"), ratio: nil))
        let v = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(v == .object([
            "kind": .string("split"), "direction": .string("vertical"),
            "first": .object(["kind": .string("leaf"), "id": .string("a")]),
            "second": .object(["kind": .string("leaf"), "id": .string("b")]),
        ]))
    }
}

@Suite struct TerminalIdTests {
    @Test func mintsDistinctIdsInTheSameMillisecond() {
        let mint = minter()
        #expect(mint.tab() == "t10")
        #expect(mint.pane() == "p11")
        #expect(mint.tab() == "t12")
    }

    @Test func paneSessionIdsRoundTrip() {
        let id = terminalPaneSessionId(surface: "ws:abc", tab: "t1", pane: "p2")
        #expect(id == "ws:abc/t1/p2")
        let ref = parseTerminalPaneSessionId(id)
        #expect(ref?.surface == "ws:abc" && ref?.tab == "t1" && ref?.pane == "p2")
        for bad in ["ws-claude:abc", "tab:terminal/t1", "tab:terminal//p1", "a/b/c/d"] {
            #expect(parseTerminalPaneSessionId(bad) == nil)
        }
    }

    @Test func serverStartedSessionsAreGuarded() {
        #expect(isServerStartedSession("ws-claude:w1"))
        #expect(isServerStartedSession("review-claude:r1"))
        #expect(!isServerStartedSession("tab:terminal/t1/p1"))
    }
}

@Suite struct TerminalSurfaceStateTests {
    @Test func startsWithOneShellOrNothing() {
        let fresh = TerminalSurfaceState.initial(opensShellTab: true, minter())
        #expect(fresh.tabs.map(\.title) == ["Terminal"])
        #expect(fresh.activeTabId == fresh.tabs[0].id)
        #expect(fresh.focused[fresh.tabs[0].id] == fresh.tabs[0].root.firstLeafId)
        #expect(TerminalSurfaceState.initial(opensShellTab: false) == .empty)
    }

    @Test func roundTripsThroughStorage() {
        let mint = minter()
        var state = TerminalSurfaceState.fresh(mint)
        state.openTab(mint)
        state.split(state.activeTabId, .horizontal, mint)
        let loaded = TerminalSurfaceState.load(state.encoded(), opensShellTab: true, mint)
        #expect(loaded == state)
    }

    @Test func loadsTheWebsJSONAndDropsOtherTabKinds() {
        let raw = json("""
        {"tabs":[{"id":"t1","title":"Terminal","kind":"terminal","root":{"kind":"split","direction":"horizontal",
          "first":{"kind":"leaf","id":"p1"},"second":{"kind":"leaf","id":"p2"},"ratio":0.4}},
          {"id":"t2","title":"a.ts","kind":"diff","repoId":"r","path":"a.ts"}],
         "activeTabId":"t1","focused":{"t1":"p2","t2":"gone"}}
        """)
        let state = TerminalSurfaceState.load(raw, opensShellTab: true)
        #expect(state.tabs.map(\.id) == ["t1"])
        #expect(state.tabs[0].root == .split(.horizontal, first: .leaf("p1"), second: .leaf("p2"), ratio: 0.4))
        #expect(state.focused == ["t1": "p2"])
    }

    @Test func unusableStorageFallsBackToTheInitialState() {
        #expect(TerminalSurfaceState.load(json("not json"), opensShellTab: false) == .empty)
        #expect(TerminalSurfaceState.load(json(#"{"tabs":[],"activeTabId":"","focused":{}}"#), opensShellTab: true).tabs.count == 1)
        #expect(TerminalSurfaceState.load(nil, opensShellTab: false) == .empty)
    }

    @Test func numbersNewTabs() {
        let mint = minter()
        var state = TerminalSurfaceState.fresh(mint)
        let id = state.openTab(mint)
        #expect(state.tabs.map(\.title) == ["Terminal", "Terminal 2"])
        #expect(state.activeTabId == id)
        var empty = TerminalSurfaceState.empty
        empty.openTab(mint)
        #expect(empty.tabs.map(\.title) == ["Terminal 1"])
    }

    @Test func closingATabSelectsTheFirstLeft() {
        let mint = minter()
        var state = TerminalSurfaceState.fresh(mint)
        let first = state.activeTabId
        let second = state.openTab(mint)
        state.closeTab(second, opensShellTab: true, fallbackPinnedKey: nil, mint)
        #expect(state.tabs.map(\.id) == [first])
        #expect(state.activeTabId == first)
        #expect(state.focused[second] == nil)
    }

    @Test func closingTheLastTabFollowsTheSurfaceKind() {
        let mint = minter()
        var shells = TerminalSurfaceState.fresh(mint)
        let only = shells.activeTabId
        shells.closeTab(only, opensShellTab: true, fallbackPinnedKey: nil, mint)
        #expect(shells.tabs.count == 1)
        #expect(shells.tabs[0].id != only)

        var workspace = TerminalSurfaceState.fresh(mint)
        workspace.closeTab(workspace.activeTabId, opensShellTab: false, fallbackPinnedKey: "agent", mint)
        #expect(workspace.tabs.isEmpty)
        #expect(workspace.activePinnedKey == "agent")

        var bare = TerminalSurfaceState.fresh(mint)
        bare.closeTab(bare.activeTabId, opensShellTab: false, fallbackPinnedKey: nil, mint)
        #expect(bare == .empty)
    }

    @Test func splitsAndClosesPanes() {
        let mint = minter()
        var state = TerminalSurfaceState.fresh(mint)
        let tab = state.activeTabId
        let original = state.focusedPane(in: tab)!
        let added = state.split(tab, .vertical, mint)!
        #expect(state.focusedPane(in: tab) == added)
        #expect(state.tab(tab)?.root.leafIds == [original, added])

        let closed = state.closePane(added, in: tab)
        #expect(closed)
        #expect(state.tab(tab)?.root == .leaf(original))
        #expect(state.focusedPane(in: tab) == original)
        // The last pane is the caller's to close, along with its tab.
        let closedLast = state.closePane(original, in: tab)
        #expect(!closedLast)
        #expect(state.tab(tab)?.root == .leaf(original))
    }

    @Test func aStaleFocusFallsBackToTheFirstPane() {
        var state = TerminalSurfaceState(tabs: [TerminalTab(id: "t", title: "T", root: .leaf("p"))],
                                         activeTabId: "t", focused: ["t": "gone"])
        #expect(state.focusedPane(in: "t") == "p")
        state.focus("other", in: "t")
        #expect(state.focused["t"] == "gone")
    }

    @Test func reordersTabs() {
        func state(_ ids: [String]) -> TerminalSurfaceState {
            TerminalSurfaceState(tabs: ids.map { TerminalTab(id: $0, title: $0, root: .leaf("p\($0)")) },
                                 activeTabId: ids[0], focused: [:])
        }
        var s = state(["a", "b", "c"])
        s.moveTab("a", nextTo: "c", after: true)
        #expect(s.tabs.map(\.id) == ["b", "c", "a"])
        s.moveTab("a", nextTo: "b", after: false)
        #expect(s.tabs.map(\.id) == ["a", "b", "c"])
        s.moveTab("a", nextTo: "missing", after: true)
        #expect(s.tabs.map(\.id) == ["a", "b", "c"])
    }

    @Test func followsThePinnedTabs() {
        var state = TerminalSurfaceState(tabs: [TerminalTab(id: "t", title: "T", root: .leaf("p"))],
                                         activeTabId: "t", focused: [:])
        state.reconcilePinned(keys: ["agent"], previous: [])
        #expect(state.activePinnedKey == "agent")
        state.reconcilePinned(keys: [], previous: ["agent"])
        #expect(state.activeTabId == "t")
    }

    @Test func flagsTabsWhosePanesWantTheUser() {
        let state = TerminalSurfaceState(tabs: [
            TerminalTab(id: "t1", title: "A", root: .leaf("p1")),
            TerminalTab(id: "t2", title: "B", root: .split(.vertical, first: .leaf("p2"), second: .leaf("p3"), ratio: nil)),
        ], activeTabId: "t1", focused: [:])
        #expect(state.sessionIds(of: "t2", surface: "tab:terminal") == ["tab:terminal/t2/p2", "tab:terminal/t2/p3"])
        #expect(state.tabIds(withSessionsIn: ["tab:terminal/t2/p3", "ws:x/t1/p1"], surface: "tab:terminal") == ["t2"])
    }
}

@Suite struct TerminalAPITests {
    @Test func clampsTheFontSize() {
        #expect(TerminalFontSize.from(nil) == 16)
        #expect(TerminalFontSize.from(0) == 16)
        #expect(TerminalFontSize.from(.nan) == 16)
        #expect(TerminalFontSize.from(4) == 10)
        #expect(TerminalFontSize.from(99) == 32)
        #expect(TerminalFontSize.from(13.6) == 14)
        #expect(TerminalFontSize.stored(16) == nil)
        #expect(TerminalFontSize.stored(18) == 18)
    }

    @Test func readsAndSavesTheFontSize() async throws {
        let (session, id) = StubProtocol.session { req, _ in
            req.url!.path.hasSuffix("get_settings") ? (200, json(#"{"terminalFontSize":40,"other":1}"#)) : (200, json("{}"))
        }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        #expect(try await client.terminalFontSize() == 32)
        try await client.setTerminalFontSize(nil)
        try await client.setTerminalFontSize(12)
        let saves = StubProtocol.recorded(id).filter { $0.0.url!.path == "/api/core/set_terminal_font_size" }
        #expect(saves.map { bodyJSON($0.1) } == [.object(["value": .null]), .object(["value": .number(12)])])
    }

    @Test func aMissingFontSizeIsTheDefault() async throws {
        let (session, _) = StubProtocol.session { _, _ in (200, json(#"{"terminalFontSize":null}"#)) }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        #expect(try await client.terminalFontSize() == 16)
    }

    @Test func busyErrorsCountAsIdle() async {
        let (busySession, id) = StubProtocol.session { _, _ in (200, json("true")) }
        let busy = YarvisClient(baseURL: base, token: "t", session: busySession)
        #expect(await busy.ptyIsBusy("tab:terminal/t/p"))
        #expect(bodyJSON(StubProtocol.recorded(id).first?.1) == .object(["id": .string("tab:terminal/t/p")]))

        let (failing, _) = StubProtocol.session { _, _ in (400, json(#"{"error":"no such session"}"#)) }
        #expect(await !YarvisClient(baseURL: base, token: "t", session: failing).ptyIsBusy("x"))
    }

    @Test func decodesTheAgentConfig() async throws {
        let (session, _) = StubProtocol.session { _, _ in
            (200, json(#"{"name":"Claude","command":"claude","harnesses":[{"id":"h1","name":"Default","kind":"claude-code","command":"claude"}],"defaultHarness":"h1"}"#))
        }
        let config = try await YarvisClient(baseURL: base, token: "t", session: session).agentConfig()
        #expect(config.harnesses.map(\.id) == ["h1"])
        #expect(config.defaultHarness == "h1")
    }
}
