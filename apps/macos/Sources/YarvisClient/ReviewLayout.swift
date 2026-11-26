import Foundation

/// One strip of tabs in a review workspace.
public struct ReviewTabGroup: Sendable, Equatable {
    /// "a" or "b". Stays with the group for its life, so a view keyed on it
    /// keeps the group's tabs alive when the other group appears or folds.
    public var key: String
    public var tabs: [ReviewTabSpec]
    public var activeId: String?

    public init(key: String, tabs: [ReviewTabSpec] = [], activeId: String? = nil) {
        self.key = key
        self.tabs = tabs
        self.activeId = activeId
    }

    public var active: ReviewTabSpec? { tabs.first { $0.id == activeId } }
}

/// The open tabs of a review workspace: one group, or two side by side. A tab
/// is open at most once across both groups, static tabs lead each strip in a
/// fixed order, and closing a group's last tab folds the split. The saved
/// shape matches the web's `tabLayout.ts`, so the rules are the same in both.
public struct ReviewTabLayout: Sendable, Equatable {
    /// One group, or two when split. Never empty.
    public var groups: [ReviewTabGroup]
    /// The group the keyboard and the nav open into.
    public var focusedGroup: Int
    /// The first group's share of the width while split.
    public var ratio: Double

    public init(groups: [ReviewTabGroup], focusedGroup: Int = 0, ratio: Double = 0.5) {
        self.groups = groups
        self.focusedGroup = focusedGroup
        self.ratio = ratio
    }

    public static var empty: ReviewTabLayout { ReviewTabLayout(groups: [newGroup([])]) }

    /// The smallest share either group gets while split.
    public static let minRatio = 0.2

    private static func newGroup(_ existing: [ReviewTabGroup]) -> ReviewTabGroup {
        ReviewTabGroup(key: existing.contains { $0.key == "a" } ? "b" : "a")
    }

    private static func rank(_ spec: ReviewTabSpec) -> Int {
        ReviewTabSpec.Kind.staticOrder.firstIndex(of: spec.kind) ?? ReviewTabSpec.Kind.staticOrder.count
    }

    /// Static tabs first by kind; the rest keep the order the user gave them.
    static func normalize(_ tabs: [ReviewTabSpec]) -> [ReviewTabSpec] {
        tabs.enumerated().sorted { a, b in
            let (ra, rb) = (rank(a.element), rank(b.element))
            return ra != rb ? ra < rb : a.offset < b.offset
        }.map(\.element)
    }

    public func find(_ id: String) -> (group: Int, index: Int)? {
        for (g, group) in groups.enumerated() {
            if let index = group.tabs.firstIndex(where: { $0.id == id }) { return (g, index) }
        }
        return nil
    }

    /// The tab showing in the focused group.
    public var activeTab: ReviewTabSpec? {
        groups.indices.contains(focusedGroup) ? groups[focusedGroup].active : nil
    }

    public var allTabs: [ReviewTabSpec] { groups.flatMap(\.tabs) }

    public var isEmpty: Bool { groups.allSatisfy { $0.tabs.isEmpty } }

    /// Opens `spec`, or focuses it where it is open already. An open file
    /// given a `revealLine` takes it with a bumped `revealNonce`, so the
    /// same line scrolls into view again; a since-file tab takes the new
    /// `from`. A new tab goes into `group` (the focused one by default),
    /// creating the second group when that one is asked for.
    public func opening(_ spec: ReviewTabSpec, group: Int? = nil) -> ReviewTabLayout {
        var next = self
        if let found = find(spec.id) {
            let old = groups[found.group].tabs[found.index]
            var replacement = old
            if spec.revealLine != nil {
                replacement = spec
                replacement.revealNonce = (old.revealNonce ?? 0) + 1
            } else if spec.kind == .sinceFile {
                replacement = spec
            }
            next.groups[found.group].tabs[found.index] = replacement
            next.groups[found.group].activeId = spec.id
            next.focusedGroup = found.group
            return next
        }
        var target = group ?? focusedGroup
        if target >= next.groups.count {
            next.groups.append(Self.newGroup(next.groups))
            target = next.groups.count - 1
        }
        next.groups[target].tabs = Self.normalize(next.groups[target].tabs + [spec])
        next.groups[target].activeId = spec.id
        next.focusedGroup = target
        return next
    }

    public func focusing(_ id: String) -> ReviewTabLayout {
        guard let found = find(id) else { return self }
        var next = self
        next.groups[found.group].activeId = id
        next.focusedGroup = found.group
        return next
    }

    /// Drops empty groups, keeping at least one, and keeps the focus on a real group.
    private func foldingEmpty() -> ReviewTabLayout {
        let kept = groups.filter { !$0.tabs.isEmpty }
        if kept.count == groups.count { return self }
        var next = self
        if kept.isEmpty {
            next.groups = [Self.newGroup([])]
            next.focusedGroup = 0
        } else {
            next.groups = kept
            next.focusedGroup = min(focusedGroup, kept.count - 1)
        }
        return next
    }

    /// Closes a tab. Closing the one showing shows its right-hand neighbour,
    /// or its left when it was last.
    public func closing(_ id: String) -> ReviewTabLayout {
        guard let found = find(id) else { return self }
        var next = self
        var g = groups[found.group]
        g.tabs.remove(at: found.index)
        if g.activeId == id {
            let neighbour = found.index < g.tabs.count ? g.tabs[found.index]
                : (found.index > 0 ? g.tabs[found.index - 1] : nil)
            g.activeId = neighbour?.id
        }
        next.groups[found.group] = g
        return next.foldingEmpty()
    }

    /// Shows the next or previous tab of the focused group, wrapping round.
    public func cycling(forward: Bool) -> ReviewTabLayout {
        guard groups.indices.contains(focusedGroup) else { return self }
        let g = groups[focusedGroup]
        guard !g.tabs.isEmpty else { return self }
        let index = max(g.tabs.firstIndex { $0.id == g.activeId } ?? 0, 0)
        let to = (index + (forward ? 1 : -1) + g.tabs.count) % g.tabs.count
        var next = self
        next.groups[focusedGroup].activeId = g.tabs[to].id
        return next
    }

    /// Moves a tab into `group`, splitting when that group doesn't exist, and
    /// shows it there. `beforeId` places it in front of another tab of that
    /// group; a static tab still lands in its fixed place.
    public func moving(_ id: String, toGroup group: Int, before beforeId: String? = nil) -> ReviewTabLayout {
        guard let found = find(id) else { return self }
        if found.group == group {
            guard let beforeId, beforeId != id else { return focusing(id) }
            return reordering(inGroup: group, id, onto: beforeId, after: false).focusing(id)
        }
        let source = groups[found.group]
        // Splitting off a group's only tab would leave that group empty beside it.
        if group >= groups.count && source.tabs.count == 1 { return focusing(id) }
        let spec = source.tabs[found.index]
        // Removing first can fold the source group away and shift the target's index.
        var next = closing(id)
        let folded = next.groups.count < groups.count
        var target = folded && found.group < group ? group - 1 : group
        if target >= next.groups.count {
            next.groups.append(Self.newGroup(next.groups))
            target = next.groups.count - 1
        }
        var tabs = next.groups[target].tabs
        if let beforeId, let at = tabs.firstIndex(where: { $0.id == beforeId }) {
            tabs.insert(spec, at: at)
        } else {
            tabs.append(spec)
        }
        next.groups[target].tabs = Self.normalize(tabs)
        next.groups[target].activeId = id
        next.focusedGroup = target
        return next
    }

    /// Moves the focused group's tab to the other group: the split toggle.
    public func movingActiveToOtherGroup() -> ReviewTabLayout {
        guard groups.indices.contains(focusedGroup), let id = groups[focusedGroup].activeId else { return self }
        return moving(id, toGroup: focusedGroup == 0 ? 1 : 0)
    }

    public func reordering(inGroup group: Int, _ dragId: String, onto targetId: String,
                           after: Bool) -> ReviewTabLayout {
        guard groups.indices.contains(group) else { return self }
        let tabs = groups[group].tabs
        guard let moved = reorderTabs(tabs.map(\.id), dragId, onto: targetId, after: after) else { return self }
        let byId = Dictionary(tabs.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var next = self
        next.groups[group].tabs = Self.normalize(moved.compactMap { byId[$0] })
        return next
    }

    public func focusingGroup(_ group: Int) -> ReviewTabLayout {
        guard group < groups.count, group != focusedGroup else { return self }
        var next = self
        next.focusedGroup = group
        return next
    }

    /// Drops the tabs of PRs no longer in the workspace. The Ask Claude tab
    /// is the workspace's, so it moves to a PR still there instead of closing
    /// with the one that opened it. `prIds` is in nav order; the first heirs it.
    public func pruning(keeping prIds: [String]) -> ReviewTabLayout {
        let keep = Set(prIds)
        var next = self
        if let heir = prIds.first {
            for g in next.groups.indices {
                for t in next.groups[g].tabs.indices
                where next.groups[g].tabs[t].kind == .claude && !keep.contains(next.groups[g].tabs[t].prId) {
                    next.groups[g].tabs[t].prId = heir
                }
            }
        }
        for tab in next.allTabs where !keep.contains(tab.prId) {
            next = next.closing(tab.id)
        }
        return next
    }

    // MARK: Saving

    private struct Stored: Codable {
        struct Group: Codable {
            var key: String?
            var activeId: String?
            var tabs: [ReviewTabSpec]
        }
        var groups: [Group]
        var focusedGroup: Int
        var ratio: Double
    }

    /// What is saved: a jump to a line is a moment, not part of the layout,
    /// and `ReviewTabSpec` never encodes it.
    public func serialized() -> Data {
        let stored = Stored(groups: groups.map { .init(key: $0.key, activeId: $0.activeId, tabs: $0.tabs) },
                            focusedGroup: focusedGroup, ratio: ratio)
        return (try? JSONEncoder().encode(stored)) ?? Data()
    }

    /// Reads a saved layout, keeping what is well-formed. Anything else gives
    /// an empty layout rather than an error: losing the open tabs costs a
    /// click, a broken view costs the workspace.
    public static func parse(_ data: Data?) -> ReviewTabLayout {
        guard let data, let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .empty
        }
        let rawGroups = (root["groups"] as? [Any] ?? []).prefix(2)
        var seen = Set<String>()
        var parsed: [ReviewTabGroup] = []
        for rawGroup in rawGroups {
            let g = rawGroup as? [String: Any] ?? [:]
            var tabs: [ReviewTabSpec] = []
            for rawTab in g["tabs"] as? [Any] ?? [] {
                guard let spec = parseSpec(rawTab), !seen.contains(spec.id) else { continue }
                seen.insert(spec.id)
                tabs.append(spec)
            }
            guard !tabs.isEmpty else { continue }
            let ids = tabs.map(\.id)
            let active = (g["activeId"] as? String).flatMap { ids.contains($0) ? $0 : nil } ?? ids[0]
            parsed.append(ReviewTabGroup(key: parsed.isEmpty ? "a" : "b", tabs: normalize(tabs), activeId: active))
        }
        guard !parsed.isEmpty else { return .empty }
        let rawRatio = (root["ratio"] as? NSNumber)?.doubleValue
        let ratio = rawRatio.flatMap { $0 > 0 && $0 < 1 ? $0 : nil } ?? ReviewTabLayout.empty.ratio
        let focused = (root["focusedGroup"] as? NSNumber)?.intValue ?? 0
        return ReviewTabLayout(groups: parsed, focusedGroup: parsed.indices.contains(focused) ? focused : 0,
                               ratio: ratio)
    }

    private static func parseSpec(_ raw: Any) -> ReviewTabSpec? {
        guard let r = raw as? [String: Any], let kindName = r["kind"] as? String,
              let kind = ReviewTabSpec.Kind(rawValue: kindName), let prId = r["prId"] as? String else { return nil }
        switch kind {
        case .diff, .file:
            guard let path = r["path"] as? String, !path.isEmpty else { return nil }
            return ReviewTabSpec(kind: kind, prId: prId, path: path)
        case .sinceFile:
            guard let path = r["path"] as? String, !path.isEmpty, let from = r["from"] as? String,
                  isFullSha(from) else { return nil }
            return .sinceFile(prId: prId, path: path, from: from)
        case .commit:
            guard let sha = r["sha"] as? String, isFullSha(sha) else { return nil }
            return .commit(prId: prId, sha: sha, subject: (r["subject"] as? String).map { String($0.prefix(200)) })
        default:
            return ReviewTabSpec(kind: kind, prId: prId)
        }
    }
}

/// Moves `dragId` next to `targetId`, before or after it. Nil when either id
/// is unknown or the drop would leave the order as it is.
public func reorderTabs(_ ids: [String], _ dragId: String, onto targetId: String, after: Bool) -> [String]? {
    guard dragId != targetId, let from = ids.firstIndex(of: dragId),
          let target = ids.firstIndex(of: targetId) else { return nil }
    var without = ids
    without.remove(at: from)
    let anchor = from < target ? target - 1 : target
    let insertAt = after ? anchor + 1 : anchor
    if insertAt == from { return nil }
    without.insert(dragId, at: insertAt)
    return without
}

// MARK: Shortcuts

/// What a key press does inside a review workspace.
public enum ReviewShortcut: Sendable, Equatable {
    case nextTab, prevTab, closeTab, otherGroup, nextFile, prevFile

    /// Ignored while typing in a text field: Cmd-W shouldn't throw away what
    /// was written, and Option-J/K type characters there.
    public var yieldsToTextEntry: Bool { self == .closeTab || self == .nextFile || self == .prevFile }

    /// A key press, without AppKit, so the mapping is testable.
    public struct Press: Sendable {
        /// `keyJ` and `keyK` are the physical keys, since Option turns the
        /// letters into symbols and other layouts put them elsewhere.
        public enum Key: Sendable, Equatable { case tab, left, right, keyJ, keyK, character(String) }
        public var key: Key
        public var command = false
        public var control = false
        public var option = false
        public var shift = false

        public init(_ key: Key, command: Bool = false, control: Bool = false, option: Bool = false,
                    shift: Bool = false) {
            self.key = key
            self.command = command
            self.control = control
            self.option = option
            self.shift = shift
        }
    }

    /// The key of a key press, from its virtual key code and its characters
    /// ignoring modifiers.
    public static func key(keyCode: UInt16, characters: String?) -> Press.Key {
        switch keyCode {
        case 48: return .tab
        case 123: return .left
        case 124: return .right
        case 38: return .keyJ
        case 40: return .keyK
        default: return .character(characters?.lowercased() ?? "")
        }
    }

    /// Cmd-digits and Cmd-Shift-[ / ] already move between the app's pages,
    /// so tabs cycle on Ctrl-Tab and Cmd-Option-arrows instead.
    public static func resolve(_ p: Press) -> ReviewShortcut? {
        let mod = p.command || p.control
        if p.control && !p.command && !p.option && p.key == .tab { return p.shift ? .prevTab : .nextTab }
        if mod && p.option && !p.shift {
            if p.key == .right { return .nextTab }
            if p.key == .left { return .prevTab }
            return nil
        }
        if p.command && !p.control && !p.option && !p.shift {
            if p.key == .character("w") { return .closeTab }
            if p.key == .character("\\") { return .otherGroup }
            return nil
        }
        if p.option && !mod && !p.shift {
            if p.key == .keyJ { return .nextFile }
            if p.key == .keyK { return .prevFile }
        }
        return nil
    }
}
