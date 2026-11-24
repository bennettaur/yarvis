import Foundation

// The Chat page's rules apart from any UI. They match the web client's
// (`chatTabs.ts`, `chat.ts`, `useChatThread.ts`, `TurnActivity.tsx`) so a
// chat behaves the same whichever client the user picks up.

// MARK: - Tabs

/// The open chat tabs and which one is in front. Saved between launches.
public struct ChatTabsState: Codable, Equatable, Sendable {
    public struct Tab: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        /// Nil for a new chat whose session is created on its first send.
        public var sessionId: String?

        public init(id: String, sessionId: String? = nil) {
            self.id = id
            self.sessionId = sessionId
        }
    }

    public private(set) var tabs: [Tab]
    public private(set) var activeId: String

    public init(tabs: [Tab], activeId: String) {
        self.tabs = tabs
        self.activeId = activeId
    }

    public static func single(_ tabId: String) -> ChatTabsState {
        ChatTabsState(tabs: [Tab(id: tabId)], activeId: tabId)
    }

    /// Reads a saved state, or nil when it's empty or broken. A saved active
    /// id that no tab has falls back to the first tab.
    public static func restore(_ data: Data?) -> ChatTabsState? {
        guard let data, var state = try? JSONDecoder().decode(ChatTabsState.self, from: data),
              let first = state.tabs.first else { return nil }
        if !state.tabs.contains(where: { $0.id == state.activeId }) { state.activeId = first.id }
        return state
    }

    public var active: Tab? { tabs.first { $0.id == activeId } }

    public mutating func add(_ tabId: String) {
        tabs.append(Tab(id: tabId))
        activeId = tabId
    }

    public mutating func select(_ tabId: String) {
        if tabs.contains(where: { $0.id == tabId }) { activeId = tabId }
    }

    /// Brings a chat on screen. A tab that already has it is focused, so one
    /// chat never runs in two tabs at once. Otherwise the active tab takes it
    /// if it's empty and `activeTabIdle`, and failing that it opens in a new
    /// tab with `newTabId`. Returns the tab that shows it.
    @discardableResult
    public mutating func open(sessionId: String, newTabId: String, activeTabIdle: Bool) -> String {
        if let existing = tabs.first(where: { $0.sessionId == sessionId }) {
            activeId = existing.id
            return existing.id
        }
        if let active, active.sessionId == nil, activeTabIdle {
            setSession(active.id, sessionId)
            return active.id
        }
        tabs.append(Tab(id: newTabId, sessionId: sessionId))
        activeId = newTabId
        return newTabId
    }

    /// Closes a tab and focuses its neighbour. Closing the last tab leaves an
    /// empty one with `newTabId`, so the page always has a composer.
    public mutating func close(_ tabId: String, newTabId: String) {
        guard let at = tabs.firstIndex(where: { $0.id == tabId }) else { return }
        tabs.remove(at: at)
        if tabs.isEmpty {
            self = .single(newTabId)
        } else if activeId == tabId {
            activeId = tabs[min(at, tabs.count - 1)].id
        }
    }

    public mutating func setSession(_ tabId: String, _ sessionId: String?) {
        guard let i = tabs.firstIndex(where: { $0.id == tabId }) else { return }
        tabs[i].sessionId = sessionId
    }
}

/// A tab's name: the session's title, "Untitled chat" for a session with
/// none, or "New chat" before it has a session.
public func chatTabLabel(sessionId: String?, sessions: [ChatSession]) -> String {
    guard let sessionId else { return "New chat" }
    return sessions.first { $0.id == sessionId }?.title ?? "Untitled chat"
}

// MARK: - Messages

/// Where a message came from, when not typed in a chat tab.
public struct ChatMessageMetadata: Codable, Sendable, Equatable {
    /// `telegram`, `voice`, `browser` or `scheduled-task`.
    public var source: String?
    public var telegramUserId: Double?
    public var telegramUsername: String?
    public var telegramFirstName: String?

    public init(source: String? = nil, telegramUserId: Double? = nil, telegramUsername: String? = nil,
                telegramFirstName: String? = nil) {
        self.source = source
        self.telegramUserId = telegramUserId
        self.telegramUsername = telegramUsername
        self.telegramFirstName = telegramFirstName
    }
}

/// The label above a message. Messages from another surface say so, and a
/// Telegram one names its sender, so they read apart from ones typed here.
public func chatMessageLabel(role: String, metadata: ChatMessageMetadata?) -> String {
    switch metadata?.source {
    // Spoken turns are transcribed, so a word that looks wrong was probably misheard.
    case "voice": return "\(role) · spoken"
    case "browser": return "\(role) · Chrome"
    // Stored with the user role, but the assistant wrote it for itself.
    case "scheduled-task": return "Yarvis · scheduled task"
    case "telegram":
        let who = metadata?.telegramUsername.flatMap { $0.isEmpty ? nil : "@\($0)" }
            ?? metadata?.telegramFirstName.flatMap { $0.isEmpty ? nil : $0 }
            ?? metadata?.telegramUserId.map { String(Int64($0)) }
        return who.map { "Telegram · \($0)" } ?? "Telegram"
    default: return role
    }
}

/// The thread as it should look the moment a turn is sent. A rewind drops
/// the chosen message and everything after it, as the sidecar does. A resend,
/// or the same text as the last user message, adds no second bubble, since
/// the sidecar counts it as the same turn.
public func messagesForTurn(_ messages: [ChatMessage], text: String, sessionId: String,
                            rewindTo: String? = nil, resend: Bool = false, now: Date = Date()) -> [ChatMessage] {
    let bubble = ChatMessage(id: "local-\(UUID().uuidString)", sessionId: sessionId, role: "user", content: text,
                             createdAt: ISO8601DateFormatter().string(from: now))
    if let rewindTo {
        let kept = messages.firstIndex { $0.id == rewindTo }.map { Array(messages[..<$0]) } ?? messages
        return kept + [bubble]
    }
    if resend { return messages }
    if let last = messages.last, last.role == "user", last.content == text { return messages }
    return messages + [bubble]
}

/// True for a message the sidecar saved, as opposed to one shown locally
/// while its turn runs. Only saved messages can be rewound to.
public func isSavedMessage(_ m: ChatMessage) -> Bool { !m.id.hasPrefix("local-") }

// MARK: - Tool activity

/// The one line a finished turn's tool calls fold under.
public func toolActivitySummary(_ tools: [ToolActivity], thought: Bool) -> String {
    if tools.isEmpty { return "Thought about it" }
    let count = "\(tools.count) tool call\(tools.count == 1 ? "" : "s")"
    let failed = tools.filter { $0.status == "error" || $0.status == "denied" }.count
    return (thought ? "Thought, " : "Used ") + count + (failed > 0 ? " · \(failed) failed" : "")
}

/// A tool call's duration: whole milliseconds under a second, else tenths of a second.
public func formatToolDuration(_ ms: Double) -> String {
    ms < 1000 ? "\(Int(ms.rounded())) ms" : String(format: "%.1f s", ms / 1000)
}

// MARK: - Queue

/// Messages typed while a turn runs, sent one per turn once it finishes.
/// After a failed or stopped turn the queue is held until the user sends
/// from it, so a bad turn doesn't fire everything typed behind it.
public struct MessageQueue: Equatable, Sendable {
    public private(set) var items: [String] = []
    public private(set) var held = false

    public init() {}

    /// False for blank text, which isn't queued.
    @discardableResult
    public mutating func enqueue(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        items.append(trimmed)
        return true
    }

    public mutating func remove(at index: Int) {
        if items.indices.contains(index) { items.remove(at: index) }
    }

    /// The message to send on its own once a turn has finished cleanly.
    public mutating func drain() -> String? {
        guard !held, !items.isEmpty else { return nil }
        return items.removeFirst()
    }

    /// The front message, for the user's "Send next" while the queue is held.
    public mutating func takeNext() -> String? {
        items.isEmpty ? nil : items.removeFirst()
    }

    public mutating func turnStarted() { held = false }

    public mutating func turnEnded(failed: Bool) {
        if failed { held = true }
    }

    /// Puts back a message whose send was refused, and holds the queue so it
    /// isn't picked straight back up.
    public mutating func sendRefused(_ text: String) {
        items.insert(text, at: 0)
        held = true
    }

    public mutating func clear() {
        items = []
        held = false
    }
}

// MARK: - Workspace mentions

/// Rewrites workspace ids in model text as `yarvis://workspace/` links named
/// after the workspace, so a reply that names one by id can open it. Only
/// known ids are linked, and never one inside a URL, a path or inline code.
public func linkWorkspaceMentions(_ text: String, names: [String: String]) -> String {
    guard !names.isEmpty else { return text }
    let lowered = Dictionary(names.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { a, _ in a })
    // Split on backticks so inline code spans (the odd segments) are left alone.
    let parts = text.components(separatedBy: "`")
    return parts.enumerated().map { i, part in
        i % 2 == 1 ? part : linkMentions(in: part, names: lowered)
    }.joined(separator: "`")
}

private let mentionPattern = try! NSRegularExpression(
    pattern: #"(?<![\w/\-\[])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\w/\-\]])"#,
    options: [.caseInsensitive])

private func linkMentions(in text: String, names: [String: String]) -> String {
    let ns = text as NSString
    var out = ""
    var last = 0
    for match in mentionPattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        let id = ns.substring(with: match.range).lowercased()
        guard let name = names[id] else { continue }
        out += ns.substring(with: NSRange(location: last, length: match.range.location - last))
        let label = name.replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
        out += "[\(label)](yarvis://workspace/\(id))"
        last = match.range.location + match.range.length
    }
    out += ns.substring(from: last)
    return out
}

// MARK: - Links

/// What following a link in a reply or an artifact does.
public enum ChatLinkAction: Equatable, Sendable {
    case openInBrowser(URL)
    case openArtifact(id: String)
    /// A `yarvis://` place the app's router opens.
    case openPlace(URL)
    case ignore
}

/// Only http(s) leaves the app, since another scheme could launch something.
/// In-app links from an untrusted artifact are ignored: its content came from
/// outside the chat, so it doesn't get to move the app around.
public func chatLinkAction(_ url: URL, fromUntrusted: Bool = false) -> ChatLinkAction {
    switch url.scheme?.lowercased() {
    case "http", "https":
        return .openInBrowser(url)
    case "yarvis":
        guard !fromUntrusted, let place = YarvisPlace(url) else { return .ignore }
        if case .artifact(let id) = place { return .openArtifact(id: id) }
        return .openPlace(url)
    default:
        return .ignore
    }
}
