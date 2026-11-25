import Foundation

/// What a clear covers: a whole workspace or one terminal session.
public enum AttentionScope: Sendable, Equatable, Hashable {
    case workspace(String)
    case session(String)
}

/// One origin's pending items, so a workspace that asks three times reads as
/// one thing wanting the user rather than three. Mirrors the web UI's
/// `attentionGroups.ts`.
public struct AttentionGroup: Sendable, Equatable, Identifiable {
    public var id: String
    /// Newest first.
    public var items: [AttentionItem]
    /// The item the row speaks for: the most urgent, then the newest.
    public var lead: AttentionItem
    /// Nil for an item with neither a workspace nor a session, which is a group of one.
    public var scope: AttentionScope?
}

/// Lower is more urgent: blocked beats broken, which beats finished work.
private let kindRank: [String: Int] = [
    "permission": 0, "question": 1, "idle": 2, "error": 3,
    "action": 4, "info": 5, "completed": 6, "message": 7,
]

private func moreUrgent(_ a: AttentionItem, than b: AttentionItem) -> Bool {
    let ra = kindRank[a.kind] ?? 8
    let rb = kindRank[b.kind] ?? 8
    return ra != rb ? ra < rb : a.seq > b.seq
}

/// Groups items by workspace when they have one, by session otherwise. Groups
/// and their items keep the newest-first order of `items`.
public func groupAttention(_ items: [AttentionItem]) -> [AttentionGroup] {
    var order: [String] = []
    var groups: [String: AttentionGroup] = [:]
    for item in items {
        let scope: AttentionScope? = item.workspaceId.map { .workspace($0) } ?? item.sessionKey.map { .session($0) }
        let key: String
        switch scope {
        case .workspace(let id): key = "workspace:\(id)"
        case .session(let id): key = "session:\(id)"
        case nil: key = "item:\(item.id)"
        }
        if var group = groups[key] {
            group.items.append(item)
            if moreUrgent(item, than: group.lead) { group.lead = item }
            groups[key] = group
        } else {
            order.append(key)
            groups[key] = AttentionGroup(id: key, items: [item], lead: item, scope: scope)
        }
    }
    return order.compactMap { groups[$0] }
}

/// The items that viewing `workspaceId` counts as having seen. Questions and
/// permission prompts stay until they're answered, since looking at the
/// workspace doesn't answer them.
public func attentionSeenByViewing(workspaceId: String, in items: [AttentionItem]) -> [AttentionItem] {
    items.filter { $0.workspaceId == workspaceId && $0.kind != "question" && $0.kind != "permission" }
}
