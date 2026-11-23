import Foundation

// State a client keeps for a chat turn and the attention bell, apart from any
// UI, so every client applies the same rules.

/// One chat turn as it streams: the reply, tool activity and pending approvals.
public struct LiveTurn: Equatable, Sendable {
    public private(set) var reply = ""
    public private(set) var tools: [ToolActivity] = []
    /// Tool calls waiting on the user, front first.
    public private(set) var approvals: [ToolApprovalRequest] = []
    /// The turn's `error` event, if it sent one.
    public private(set) var failure: String?

    public init() {}

    public mutating func apply(_ event: ChatStreamEvent) {
        switch event {
        case .delta(let t): reply += t
        case .toolCall(let call): tools.append(call)
        case .toolResult(let id, let status, let result, let ms):
            guard let i = tools.firstIndex(where: { $0.id == id }) else { return }
            tools[i].status = status
            tools[i].result = result
            tools[i].durationMs = ms
        case .approvalRequest(let request): approvals.append(request)
        case .error(let message, let detail):
            failure = detail.map { "\(message) \($0)" } ?? message
        case .done, .reasoning, .attention, .ping, .unknown: break
        }
    }

    public mutating func answered(_ id: String) {
        approvals.removeAll { $0.id == id }
    }

    /// How a turn ended, once its stream closed.
    public enum Outcome: Equatable, Sendable {
        /// The reply was saved; reload the thread to show it.
        case saved
        /// The sidecar saved nothing; show the reason as an error.
        case failed(String)
        /// The user stopped it, and the sidecar saved nothing. A notice, not an error.
        case stopped
    }

    /// Ends the turn. Approvals are moot once it's over, and a reply that
    /// wasn't saved is dropped, while its tool activity stays on screen.
    public mutating func finish(cancelled: Bool) -> Outcome {
        approvals = []
        if cancelled {
            reply = ""
            return .stopped
        }
        if let failure {
            reply = ""
            return .failed(failure)
        }
        return .saved
    }
}

/// The bell's contents: pending attention items and server approvals, and
/// which of them are news worth a notification.
public struct AttentionInbox: Equatable, Sendable {
    /// Pending items, newest first.
    public private(set) var items: [AttentionItem] = []
    public private(set) var approvals: [Approval] = []
    private var seen = Set<String>()
    private var itemsLoaded = false
    private var approvalsLoaded = false

    public init() {}

    public var count: Int { items.count + approvals.count }

    /// Replaces the items with a fresh list. Returns the ones to announce:
    /// none on the first load, since what was waiting at launch isn't news.
    public mutating func loadItems(_ pending: [AttentionItem]) -> [AttentionItem] {
        items = pending.sorted { $0.seq > $1.seq }
        let fresh = pending.filter { seen.insert($0.id).inserted }
        defer { itemsLoaded = true }
        return itemsLoaded ? fresh : []
    }

    /// Applies one row from the stream. Returns it if it's news.
    public mutating func apply(_ item: AttentionItem) -> AttentionItem? {
        items.removeAll { $0.id == item.id }
        guard item.status == "pending" else { return nil }
        items.append(item)
        items.sort { $0.seq > $1.seq }
        return seen.insert(item.id).inserted ? item : nil
    }

    public mutating func remove(itemId: String) {
        items.removeAll { $0.id == itemId }
    }

    public mutating func loadApprovals(_ pending: [Approval]) -> [Approval] {
        approvals = pending
        let fresh = pending.filter { seen.insert($0.id).inserted }
        defer { approvalsLoaded = true }
        return approvalsLoaded ? fresh : []
    }

    public mutating func remove(approvalId: String) {
        approvals.removeAll { $0.id == approvalId }
    }
}
