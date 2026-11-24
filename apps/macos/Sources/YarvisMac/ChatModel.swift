import Foundation
import Observation
import YarvisClient

/// The Chat page: its tabs, each with its own thread, the shared session
/// list and model choices, and the artifact pane, as the web's `ChatTabs` keeps them.
@MainActor @Observable
final class ChatModel {
    unowned let app: AppModel
    private let client: YarvisClient

    var sessions: [ChatSession] = []
    var sessionsError: String?
    private(set) var providers: [ProviderInfo] = []
    private(set) var tabs: ChatTabsState {
        didSet { UserDefaults.standard.set(try? JSONEncoder().encode(tabs), forKey: Self.tabsKey) }
    }
    private(set) var threads: [String: ChatThread] = [:]
    var historyOpen: Bool {
        didSet { UserDefaults.standard.set(historyOpen, forKey: Self.historyKey) }
    }
    /// The Thinking checkbox, shared by every tab.
    var reasoningOn: Bool {
        didSet { UserDefaults.standard.set(reasoningOn, forKey: Self.reasoningKey) }
    }
    /// The artifact open in the side pane.
    private(set) var artifact: ChatArtifactModel?
    let mcp: McpConnectionModel

    private static let tabsKey = "yarvis.chat.tabs"
    private static let historyKey = "yarvis.chat.historyOpen"
    private static let reasoningKey = "yarvis.chat.reasoning"
    private static let providerKey = "chat.provider"
    private static let modelKey = "chat.model"

    init(app: AppModel, client: YarvisClient) {
        self.app = app
        self.client = client
        let defaults = UserDefaults.standard
        tabs = ChatTabsState.restore(defaults.data(forKey: Self.tabsKey)) ?? .single(UUID().uuidString)
        historyOpen = defaults.object(forKey: Self.historyKey) as? Bool ?? true
        reasoningOn = defaults.bool(forKey: Self.reasoningKey)
        mcp = McpConnectionModel(client: client)
        for tab in tabs.tabs {
            threads[tab.id] = ChatThread(id: tab.id, sessionId: tab.sessionId, chat: self, client: client)
        }
        reloadSessions()
        reloadProviders()
    }

    var activeThread: ChatThread? { threads[tabs.activeId] }

    func thread(_ tabId: String) -> ChatThread? { threads[tabId] }

    func label(_ tab: ChatTabsState.Tab) -> String {
        chatTabLabel(sessionId: threads[tab.id]?.sessionId ?? tab.sessionId, sessions: sessions)
    }

    func isOpen(sessionId: String) -> Bool {
        tabs.tabs.contains { threads[$0.id]?.sessionId == sessionId }
    }

    // MARK: Interface for AppModel

    func handle(_ event: ServerEvent) {
        if event.kind == "sidecar.started" {
            reloadSessions()
            reloadProviders()
        }
    }

    func resync() {
        reloadSessions()
        for thread in threads.values { thread.reload() }
    }

    /// Opens a thread asked for from another page, such as an attention item.
    func openSession(_ id: String) {
        let newTab = UUID().uuidString
        let shownIn = tabs.open(sessionId: id, newTabId: newTab,
                                activeTabIdle: !(activeThread?.busy ?? false))
        if let thread = threads[shownIn] {
            if thread.sessionId != id { thread.load(id) }
        } else {
            threads[shownIn] = makeThread(shownIn, sessionId: id)
        }
    }

    func stop() {
        for thread in threads.values { thread.stop() }
        artifact?.stop()
        mcp.stopPolling()
    }

    // MARK: Tabs

    func newTab() {
        let id = UUID().uuidString
        tabs.add(id)
        threads[id] = makeThread(id, sessionId: nil)
    }

    private func makeThread(_ tabId: String, sessionId: String?) -> ChatThread {
        let thread = ChatThread(id: tabId, sessionId: sessionId, chat: self, client: client)
        thread.adoptDefaultModel(defaultPick)
        return thread
    }

    func select(_ tabId: String) {
        tabs.select(tabId)
    }

    /// Closes a tab, stopping its turn if one is running.
    func close(_ tabId: String) {
        threads[tabId]?.stop()
        threads[tabId] = nil
        let replacement = UUID().uuidString
        tabs.close(tabId, newTabId: replacement)
        if threads[replacement] == nil, tabs.tabs.contains(where: { $0.id == replacement }) {
            threads[replacement] = makeThread(replacement, sessionId: nil)
        }
    }

    // MARK: Sessions

    func reloadSessions() {
        Task {
            do {
                sessions = try await client.chatSessions()
                sessionsError = nil
            } catch {
                sessionsError = error.localizedDescription
            }
        }
    }

    func sessionCreated(_ session: ChatSession, inTab tabId: String) {
        tabs.setSession(tabId, session.id)
        if !sessions.contains(where: { $0.id == session.id }) { sessions.insert(session, at: 0) }
    }

    /// The server names a thread after its first turn, so the list is read
    /// again while this one has no title.
    func turnFinished(sessionId: String) {
        if sessions.first(where: { $0.id == sessionId })?.title == nil { reloadSessions() }
    }

    // MARK: Providers

    func reloadProviders() {
        Task {
            do {
                providers = try await client.chatProviders()
                for thread in threads.values { thread.adoptDefaultModel(defaultPick) }
            } catch {
                sessionsError = error.localizedDescription
            }
        }
    }

    private var defaultPick: (provider: String, model: String)? {
        defaultChatModel(providers, savedProvider: UserDefaults.standard.string(forKey: Self.providerKey),
                         savedModel: UserDefaults.standard.string(forKey: Self.modelKey))
    }

    /// Each tab keeps its own model, and a new tab starts from the last pick.
    func remember(provider: String, model: String) {
        UserDefaults.standard.set(provider, forKey: Self.providerKey)
        UserDefaults.standard.set(model, forKey: Self.modelKey)
    }

    /// The page came back into view or the window regained focus.
    func becameVisible() {
        reloadSessions()
        reloadProviders()
        mcp.recheck()
    }

    // MARK: Links and artifacts

    /// Follows a link in a reply. http(s) goes to the browser, an artifact
    /// link opens the side pane, and other `yarvis://` links go through the
    /// app's router. Anything else stays inert.
    func follow(_ url: URL, fromUntrusted: Bool = false) -> Bool {
        switch url.scheme?.lowercased() {
        case "http", "https":
            return true
        case "yarvis":
            guard !fromUntrusted else { return false }
            if case .artifact(let id) = YarvisPlace(url) {
                openArtifact(id)
                return true
            }
            return app.open(link: url)
        default:
            return false
        }
    }

    func openArtifact(_ id: String) {
        if artifact?.id == id { return }
        artifact?.stop()
        let pane = ChatArtifactModel(id: id, client: client)
        artifact = pane
        pane.start()
    }

    func closeArtifact() {
        artifact?.stop()
        artifact = nil
    }

    var workspaceNames: [String: String] {
        Dictionary((app.workspaces?.workspaces ?? []).map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
    }
}
