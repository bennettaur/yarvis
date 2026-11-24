import Foundation

// The tabs and split panes of a terminal surface, as the web's
// `terminalTabs/paneTree.ts` and `surfaceState.ts` keep them. The JSON shape
// is the web's, so both clients describe a layout the same way.

/// `vertical` puts panes side by side; `horizontal` stacks them.
public enum SplitDirection: String, Codable, Sendable {
    case vertical, horizontal
}

/// One step from a split to one of its sides. A path of steps names a split,
/// since splits carry no id.
public enum PaneStep: Sendable, Equatable {
    case first, second
}

/// A tab's pane tree: one terminal, or two panes split along a direction.
public indirect enum TerminalPane: Equatable, Sendable {
    case leaf(String)
    /// `ratio` is the share of the split's axis `first` gets; nil is an even split.
    case split(SplitDirection, first: TerminalPane, second: TerminalPane, ratio: Double?)

    /// Every leaf id, left to right and top to bottom.
    public var leafIds: [String] {
        switch self {
        case .leaf(let id): return [id]
        case .split(_, let first, let second, _): return first.leafIds + second.leafIds
        }
    }

    public var firstLeafId: String {
        switch self {
        case .leaf(let id): return id
        case .split(_, let first, _, _): return first.firstLeafId
        }
    }

    public func contains(_ id: String) -> Bool {
        leafIds.contains(id)
    }

    /// Splits leaf `target`, putting leaf `newId` to its right or below it.
    /// Unchanged when `target` isn't in the tree.
    public func splitting(_ target: String, _ direction: SplitDirection, newId: String) -> TerminalPane {
        switch self {
        case .leaf(let id):
            return id == target ? .split(direction, first: self, second: .leaf(newId), ratio: nil) : self
        case .split(let d, let first, let second, let ratio):
            return .split(d, first: first.splitting(target, direction, newId: newId),
                          second: second.splitting(target, direction, newId: newId), ratio: ratio)
        }
    }

    /// The tree without leaf `target`; the other side of its split takes the
    /// split's place. Nil when `target` was the only leaf.
    public func removing(_ target: String) -> TerminalPane? {
        switch self {
        case .leaf(let id):
            return id == target ? nil : self
        case .split(let d, let first, let second, let ratio):
            guard let keptFirst = first.removing(target) else { return second }
            guard let keptSecond = second.removing(target) else { return first }
            return .split(d, first: keptFirst, second: keptSecond, ratio: ratio)
        }
    }

    /// Sets the ratio of the split at `path`. Unchanged when the path doesn't
    /// end on a split, such as a stale one after the layout changed.
    public func settingRatio(at path: [PaneStep], _ ratio: Double) -> TerminalPane {
        guard case .split(let d, let first, let second, let old) = self else { return self }
        guard let step = path.first else {
            return .split(d, first: first, second: second, ratio: min(max(ratio, 0.05), 0.95))
        }
        let rest = Array(path.dropFirst())
        switch step {
        case .first: return .split(d, first: first.settingRatio(at: rest, ratio), second: second, ratio: old)
        case .second: return .split(d, first: first, second: second.settingRatio(at: rest, ratio), ratio: old)
        }
    }
}

extension TerminalPane: Codable {
    private enum Keys: String, CodingKey {
        case kind, id, direction, first, second, ratio
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "leaf":
            self = .leaf(try c.decode(String.self, forKey: .id))
        case "split":
            self = .split(try c.decode(SplitDirection.self, forKey: .direction),
                          first: try c.decode(TerminalPane.self, forKey: .first),
                          second: try c.decode(TerminalPane.self, forKey: .second),
                          ratio: try c.decodeIfPresent(Double.self, forKey: .ratio))
        case let kind:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown pane kind \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .leaf(let id):
            try c.encode("leaf", forKey: .kind)
            try c.encode(id, forKey: .id)
        case .split(let d, let first, let second, let ratio):
            try c.encode("split", forKey: .kind)
            try c.encode(d, forKey: .direction)
            try c.encode(first, forKey: .first)
            try c.encode(second, forKey: .second)
            try c.encodeIfPresent(ratio, forKey: .ratio)
        }
    }
}

/// A surface's own tab: a tree of terminal panes.
public struct TerminalTab: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    /// Always `terminal`; kept so the JSON matches the web's.
    public var kind: String = "terminal"
    public var root: TerminalPane

    public init(id: String, title: String, root: TerminalPane) {
        self.id = id
        self.title = title
        self.root = root
    }
}

/// Makes tab and pane uids like the web's: `t` or `p`, the time in base 36,
/// then a counter in base 36, so two minted in the same millisecond differ.
public final class TerminalUidMinter: @unchecked Sendable {
    public static let shared = TerminalUidMinter()
    private let lock = NSLock()
    private var counter = 0
    private let now: @Sendable () -> Date

    public init(now: @escaping @Sendable () -> Date = Date.init) {
        self.now = now
    }

    public func tab() -> String { next("t") }
    public func pane() -> String { next("p") }

    private func next(_ kind: String) -> String {
        let count = lock.withLock { () -> Int in
            defer { counter += 1 }
            return counter
        }
        let ms = Int(now().timeIntervalSince1970 * 1000)
        return kind + String(ms, radix: 36) + String(count, radix: 36)
    }
}

/// A pane's PTY id, `<surfaceKey>/<tabId>/<paneId>`. Attention items name
/// panes by it, so it must stay in this shape.
public func terminalPaneSessionId(surface: String, tab: String, pane: String) -> String {
    "\(surface)/\(tab)/\(pane)"
}

/// The parts of a pane's PTY id; nil for any other id, such as `ws-claude:…`.
public func parseTerminalPaneSessionId(_ id: String) -> (surface: String, tab: String, pane: String)? {
    let parts = id.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 3, parts.allSatisfy({ !$0.isEmpty }) else { return nil }
    return (parts[0], parts[1], parts[2])
}

/// What one terminal surface keeps between launches: its tabs, which one is
/// selected, and the last focused pane of each tab.
public struct TerminalSurfaceState: Codable, Equatable, Sendable {
    public var tabs: [TerminalTab]
    /// A tab id, `pinned:<key>` for a pinned tab, or empty.
    public var activeTabId: String
    public var focused: [String: String]

    public init(tabs: [TerminalTab], activeTabId: String, focused: [String: String]) {
        self.tabs = tabs
        self.activeTabId = activeTabId
        self.focused = focused
    }

    public static let empty = TerminalSurfaceState(tabs: [], activeTabId: "", focused: [:])

    /// One shell tab named "Terminal".
    public static func fresh(_ mint: TerminalUidMinter = .shared) -> TerminalSurfaceState {
        let tab = mint.tab()
        let pane = mint.pane()
        return TerminalSurfaceState(tabs: [TerminalTab(id: tab, title: "Terminal", root: .leaf(pane))],
                                    activeTabId: tab, focused: [tab: pane])
    }

    /// What a surface holds with no tabs of its own: one shell when it opens
    /// a shell tab, otherwise nothing, so the owner's pinned tab is all it shows.
    public static func initial(opensShellTab: Bool, _ mint: TerminalUidMinter = .shared) -> TerminalSurfaceState {
        opensShellTab ? fresh(mint) : empty
    }

    /// The saved state, or the initial one when nothing usable is saved.
    /// Tabs of kinds this client doesn't show (the web's diff and editor
    /// tabs) are dropped.
    public static func load(_ data: Data?, opensShellTab: Bool, _ mint: TerminalUidMinter = .shared) -> TerminalSurfaceState {
        struct Loose: Decodable {
            var tabs: [Lossy]?
            var activeTabId: String?
            var focused: [String: String]?
        }
        struct Lossy: Decodable {
            var tab: TerminalTab?
            init(from decoder: Decoder) throws { tab = try? TerminalTab(from: decoder) }
        }
        guard let data, let loose = try? JSONDecoder().decode(Loose.self, from: data) else {
            return initial(opensShellTab: opensShellTab, mint)
        }
        let tabs = (loose.tabs ?? []).compactMap(\.tab).filter { $0.kind == "terminal" }
        guard !tabs.isEmpty else { return initial(opensShellTab: opensShellTab, mint) }
        var state = TerminalSurfaceState(tabs: tabs, activeTabId: loose.activeTabId ?? "", focused: loose.focused ?? [:])
        state.focused = state.focused.filter { id, pane in tabs.first { $0.id == id }?.root.contains(pane) == true }
        return state
    }

    public func encoded() -> Data {
        (try? JSONEncoder().encode(self)) ?? Data()
    }

    public static func pinnedTabId(_ key: String) -> String { "pinned:\(key)" }

    /// The pinned key `activeTabId` selects, if it selects one.
    public var activePinnedKey: String? {
        activeTabId.hasPrefix("pinned:") ? String(activeTabId.dropFirst("pinned:".count)) : nil
    }

    public func tab(_ id: String) -> TerminalTab? {
        tabs.first { $0.id == id }
    }

    /// The focused pane of a tab: the one saved, or the first when that's gone.
    public func focusedPane(in tabId: String) -> String? {
        guard let tab = tab(tabId) else { return nil }
        if let pane = focused[tabId], tab.root.contains(pane) { return pane }
        return tab.root.firstLeafId
    }

    public func sessionIds(of tabId: String, surface: String) -> [String] {
        (tab(tabId)?.root.leafIds ?? []).map { terminalPaneSessionId(surface: surface, tab: tabId, pane: $0) }
    }

    /// Tabs with a pane whose PTY id is in `sessionKeys`, such as the
    /// sessions with a pending attention item.
    public func tabIds(withSessionsIn sessionKeys: Set<String>, surface: String) -> Set<String> {
        Set(tabs.filter { tab in sessionIds(of: tab.id, surface: surface).contains { sessionKeys.contains($0) } }.map(\.id))
    }

    /// Adds a tab named "Terminal N" and selects it. Returns the new tab's id.
    @discardableResult
    public mutating func openTab(_ mint: TerminalUidMinter = .shared) -> String {
        let tab = mint.tab()
        let pane = mint.pane()
        tabs.append(TerminalTab(id: tab, title: "Terminal \(tabs.count + 1)", root: .leaf(pane)))
        activeTabId = tab
        focused[tab] = pane
        return tab
    }

    /// Removes a tab. Its sessions are the caller's to kill. Closing the last
    /// tab opens a fresh one when the surface opens a shell tab; otherwise the
    /// surface selects `fallbackPinnedKey`, or nothing.
    public mutating func closeTab(_ id: String, opensShellTab: Bool, fallbackPinnedKey: String?,
                                  _ mint: TerminalUidMinter = .shared) {
        let remaining = tabs.filter { $0.id != id }
        if remaining.isEmpty {
            if opensShellTab {
                self = .fresh(mint)
            } else {
                self = TerminalSurfaceState(tabs: [], activeTabId: fallbackPinnedKey.map(Self.pinnedTabId) ?? "",
                                            focused: [:])
            }
            return
        }
        tabs = remaining
        focused[id] = nil
        if activeTabId == id { activeTabId = remaining[0].id }
    }

    /// Splits the tab's focused pane and focuses the new one. Returns the new
    /// pane's id, or nil for an unknown tab.
    @discardableResult
    public mutating func split(_ tabId: String, _ direction: SplitDirection, _ mint: TerminalUidMinter = .shared) -> String? {
        guard let index = tabs.firstIndex(where: { $0.id == tabId }), let target = focusedPane(in: tabId) else { return nil }
        let pane = mint.pane()
        tabs[index].root = tabs[index].root.splitting(target, direction, newId: pane)
        focused[tabId] = pane
        return pane
    }

    /// Removes a pane and focuses the first one left. False when it's the
    /// tab's last pane: closing that closes the tab, which is the caller's call.
    public mutating func closePane(_ paneId: String, in tabId: String) -> Bool {
        guard let index = tabs.firstIndex(where: { $0.id == tabId }),
              let root = tabs[index].root.removing(paneId) else { return false }
        tabs[index].root = root
        focused[tabId] = root.firstLeafId
        return true
    }

    public mutating func setRatio(_ ratio: Double, at path: [PaneStep], in tabId: String) {
        guard let index = tabs.firstIndex(where: { $0.id == tabId }) else { return }
        tabs[index].root = tabs[index].root.settingRatio(at: path, ratio)
    }

    public mutating func focus(_ paneId: String, in tabId: String) {
        guard tab(tabId)?.root.contains(paneId) == true else { return }
        focused[tabId] = paneId
    }

    /// Moves tab `dragId` next to tab `targetId`.
    public mutating func moveTab(_ dragId: String, nextTo targetId: String, after: Bool) {
        guard dragId != targetId, let from = tabs.firstIndex(where: { $0.id == dragId }),
              let target = tabs.firstIndex(where: { $0.id == targetId }) else { return }
        let tab = tabs.remove(at: from)
        let anchor = from < target ? target - 1 : target
        tabs.insert(tab, at: after ? anchor + 1 : anchor)
    }

    /// Follows the owner's pinned tabs: selects one that just appeared, and
    /// moves off a selected one that went away.
    public mutating func reconcilePinned(keys: [String], previous: [String]) {
        if let active = activePinnedKey, !keys.contains(active) {
            activeTabId = tabs.first?.id ?? ""
        }
        if let appeared = keys.first(where: { !previous.contains($0) }) {
            activeTabId = Self.pinnedTabId(appeared)
        }
    }
}
