import Foundation

// State a client keeps for a chat turn and the attention bell, apart from any
// UI, so every client applies the same rules.

/// Why a turn failed: one line to show, and the detail behind it.
public struct TurnFailure: Equatable, Sendable {
    public var message: String
    public var detail: String?

    public init(message: String, detail: String? = nil) {
        self.message = message
        self.detail = detail
    }

    /// The server's words for an error, split as its body splits them.
    public init(_ error: Error) {
        if case let YarvisError.http(_, message, detail) = error {
            self.init(message: message, detail: detail)
        } else {
            self.init(message: error.localizedDescription)
        }
    }
}

/// One chat turn as it streams: the reply, reasoning, tool activity and
/// pending approvals.
public struct LiveTurn: Equatable, Sendable {
    public private(set) var reply = ""
    /// The model's reasoning, when the turn asked for it. Never saved.
    public private(set) var reasoning = ""
    public private(set) var reasoningStartedAt: Date?
    /// When the reasoning gave way to a reply, a tool call or the end.
    public private(set) var reasoningEndedAt: Date?
    public private(set) var tools: [ToolActivity] = []
    /// Tool calls waiting on the user, front first.
    public private(set) var approvals: [ToolApprovalRequest] = []
    /// The turn's `error` event, if it sent one.
    public private(set) var failure: TurnFailure?

    public init() {}

    public var isReasoning: Bool { reasoningStartedAt != nil && reasoningEndedAt == nil }

    /// Whole seconds spent reasoning, once it has stopped.
    public var reasoningSeconds: Int? {
        guard let start = reasoningStartedAt, let end = reasoningEndedAt else { return nil }
        return max(1, Int(end.timeIntervalSince(start).rounded()))
    }

    /// True when nothing of the turn has arrived yet.
    public var isEmpty: Bool { reply.isEmpty && reasoning.isEmpty && tools.isEmpty }

    public mutating func apply(_ event: ChatStreamEvent, at now: Date = Date()) {
        switch event {
        case .reasoning(let t):
            guard !t.isEmpty else { return }
            if reasoningStartedAt == nil { reasoningStartedAt = now }
            reasoning += t
        case .delta(let t):
            endReasoning(now)
            reply += t
        case .toolCall(let call):
            endReasoning(now)
            tools.append(call)
        case .toolResult(let id, let status, let result, let ms):
            guard let i = tools.firstIndex(where: { $0.id == id }) else { return }
            tools[i].status = status
            tools[i].result = result
            tools[i].durationMs = ms
        case .approvalRequest(let request): approvals.append(request)
        case .error(let message, let detail):
            failure = TurnFailure(message: message, detail: detail)
        case .done, .attention, .ping, .unknown: break
        }
    }

    private mutating func endReasoning(_ now: Date) {
        if reasoningStartedAt != nil, reasoningEndedAt == nil { reasoningEndedAt = now }
    }

    public mutating func answered(_ id: String) {
        approvals.removeAll { $0.id == id }
    }

    /// How a turn ended, once its stream closed.
    public enum Outcome: Equatable, Sendable {
        /// The reply was saved; reload the thread to show it.
        case saved
        /// The sidecar saved nothing; show the reason as an error.
        case failed(TurnFailure)
        /// The user stopped it, and the sidecar saved nothing. A notice, not an error.
        case stopped
    }

    /// Ends the turn. Approvals are moot once it's over, and a reply that
    /// wasn't saved is dropped, while its tool activity stays on screen.
    public mutating func finish(cancelled: Bool, at now: Date = Date()) -> Outcome {
        approvals = []
        endReasoning(now)
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

    /// Ends a turn whose request failed before or during the stream.
    public mutating func fail(_ failure: TurnFailure, at now: Date = Date()) {
        self.failure = failure
        _ = finish(cancelled: false, at: now)
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

    public mutating func remove(itemIds: Set<String>) {
        items.removeAll { itemIds.contains($0.id) }
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
