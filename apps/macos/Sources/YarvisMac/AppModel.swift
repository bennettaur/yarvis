import AppKit
import Foundation
import Observation
import YarvisClient

/// The pages in the sidebar, in the web UI's nav order. Settings is pinned
/// to the bottom, as in the web UI's rail.
enum Section: String, Hashable, CaseIterable {
    case chat, terminal, workspaces, settings

    static let top: [Section] = [.chat, .terminal, .workspaces]

    var title: String {
        switch self {
        case .chat: return "Chat"
        case .terminal: return "Terminal"
        case .workspaces: return "Workspaces"
        case .settings: return "Settings"
        }
    }

    var symbol: String {
        switch self {
        case .chat: return "bubble.left.and.bubble.right"
        case .terminal: return "terminal"
        case .workspaces: return "square.stack.3d.up"
        case .settings: return "gearshape"
        }
    }
}

/// The signed-in connection and everything that hangs off it.
@MainActor @Observable
final class AppModel {
    private(set) var server: URL?
    private(set) var client: YarvisClient?
    private(set) var device: Device?
    /// Why the app last signed out on its own, shown on the sign-in screen.
    var signOutReason: String?
    var section: Section = Section(rawValue: UserDefaults.standard.string(forKey: "section") ?? "") ?? .chat {
        didSet { UserDefaults.standard.set(section.rawValue, forKey: "section") }
    }
    /// The attention panel, which slides in from the bell like the web UI's.
    var attentionOpen = false
    /// A code prompt is up while this is set; the sheet resumes it.
    var codeRequest: CheckedContinuation<String?, Never>?

    private(set) var chat: ChatModel?
    private(set) var attention: AttentionModel?
    private(set) var terminals: TerminalsModel?
    private(set) var workspaces: WorkspacesModel?
    private(set) var settings: SettingsModel?
    private var events: EventStream?
    private var eventsTask: Task<Void, Never>?
    /// Changes on every connect and sign-out, so a 401 or 4401 that an older
    /// connection reports late can't sign out the current one.
    private var connection = UUID()

    private static let serverKey = "serverURL"
    private static let revokedMessage = "This device was signed out by the server."

    var lastServer: String { UserDefaults.standard.string(forKey: Self.serverKey) ?? "" }

    /// Signs back in with the token saved for the last server, if any.
    func restore() {
        guard let saved = UserDefaults.standard.string(forKey: Self.serverKey),
              let url = try? parseServerURL(saved),
              let token = TokenStore.load(server: url)
        else { return }
        connect(server: url, token: token, device: nil)
    }

    func signIn(serverInput: String, _ request: SignInRequest) async throws {
        let url = try parseServerURL(serverInput)
        let signedIn = try await YarvisClient.signIn(baseURL: url, request)
        try TokenStore.save(signedIn.token, server: url)
        UserDefaults.standard.set(url.absoluteString, forKey: Self.serverKey)
        signOutReason = nil
        connect(server: url, token: signedIn.token, device: signedIn.device)
    }

    private func connect(server: URL, token: String, device: Device?) {
        let connection = UUID()
        self.connection = connection
        let client = YarvisClient(baseURL: server, token: token) { [weak self] in
            Task { @MainActor in self?.serverSignedOut(connection: connection) }
        }
        self.server = server
        self.client = client
        self.device = device
        chat = ChatModel(app: self, client: client)
        attention = AttentionModel(app: self, client: client)
        terminals = TerminalsModel(app: self, client: client)
        workspaces = WorkspacesModel(app: self, client: client)
        settings = SettingsModel(app: self, client: client)
        attention?.start()
        startEvents(server: server, token: token, connection: connection)
        if device == nil {
            Task { self.device = try? await client.me() }
        }
    }

    private func startEvents(server: URL, token: String, connection: UUID) {
        let events = EventStream(baseURL: server, token: token)
        self.events = events
        eventsTask = Task { [weak self] in
            await events.start()
            for await update in events.updates {
                guard let self else { return }
                switch update {
                case .event(let e): self.handle(e)
                case .lagged: self.resync()
                case .signedOut: self.serverSignedOut(connection: connection)
                case .refused, .disconnected: break
                }
            }
        }
    }

    private func handle(_ event: ServerEvent) {
        switch event.kind {
        case "approval.requested", "approval.answered":
            attention?.reloadApprovals()
        case "sidecar.started":
            attention?.reload()
        default:
            break
        }
        chat?.handle(event)
        terminals?.handle(event)
        workspaces?.handle(event)
        settings?.handle(event)
    }

    /// Events were missed (`lagged`), so every page reads its data again.
    private func resync() {
        attention?.reloadApprovals()
        attention?.reload()
        chat?.resync()
        terminals?.resync()
        workspaces?.resync()
        settings?.resync()
    }

    /// True from the user pressing Sign Out until the app has forgotten the token.
    private(set) var signingOut = false

    /// The user's Sign Out: revokes this device on the server, and forgets
    /// the token here even if the revoke fails.
    func signOut() async {
        guard let client, let server, !signingOut else { return }
        signingOut = true
        defer { signingOut = false }
        // Sockets close first, so the 4401 the revoke sends them isn't taken
        // for the server signing this device out.
        stopConnections()
        // The Keychain copy goes before the request, so quitting mid-revoke
        // can't leave it behind.
        TokenStore.delete(server: server)
        var reason: String?
        do {
            try await client.revokeThisDevice()
        } catch {
            reason = "Signed out on this Mac, but the server may not have heard (\(error.localizedDescription)). "
                + "This device may still be listed under Settings → Devices in the web UI; revoke it there."
        }
        forget(reason: reason)
    }

    /// The server refused this device's token (a 401 or a 4401 close).
    private func serverSignedOut(connection: UUID) {
        guard connection == self.connection, !signingOut else { return }
        forget(reason: Self.revokedMessage)
    }

    /// A terminal's socket was closed with 4401.
    func serverSignedOut(client: YarvisClient) {
        guard client === self.client else { return }
        serverSignedOut(connection: connection)
    }

    private func stopConnections() {
        eventsTask?.cancel()
        if let events { Task { await events.stop() } }
        attention?.stop()
        chat?.stop()
        terminals?.stop()
        workspaces?.stop()
        settings?.stop()
    }

    /// Drops the token and everything signed in with it, and shows sign-in.
    private func forget(reason: String?) {
        guard let server else { return }
        TokenStore.delete(server: server)
        // Safe to repeat after Sign Out already stopped them.
        stopConnections()
        connection = UUID()
        events = nil
        client = nil
        device = nil
        chat = nil
        attention = nil
        terminals = nil
        workspaces = nil
        settings = nil
        self.server = nil
        signOutReason = reason
        codeRequest?.resume(returning: nil)
        codeRequest = nil
    }

    /// Why the last code was refused, shown in the prompt.
    var codeRefusal: String?

    /// Asks for an authenticator code; nil when the user cancels.
    func askForCode(refusal: String?) async -> String? {
        codeRequest?.resume(returning: nil)
        codeRefusal = refusal
        return await withCheckedContinuation { codeRequest = $0 }
    }

    func answerCode(_ code: String?) {
        codeRequest?.resume(returning: code)
        codeRequest = nil
    }

    /// Runs an action, asking for a code and retrying once if the server
    /// wants a fresh check.
    func withFreshCode<T: Sendable>(_ action: @Sendable () async throws -> T) async throws -> T {
        guard let client else { throw YarvisError.unauthorized }
        return try await client.withFreshCode({ await self.askForCode(refusal: $0) }, action)
    }

    /// Bumped to ask the main window to open the web UI window, which only a
    /// view can do.
    var webUIRequests = 0

    func showWebUI() {
        webUIRequests += 1
    }

    // MARK: Moving between pages

    /// Steps through every page, Settings included, wrapping around.
    func cycleSection(by step: Int) {
        let all = Section.allCases
        let index = all.firstIndex(of: section) ?? 0
        section = all[(index + step + all.count) % all.count]
    }

    func openChat(sessionId: String) {
        section = .chat
        chat?.openSession(sessionId)
    }

    /// Shows the workspace, and brings `focusSessionKey` (one of its terminal
    /// panes, or its agent) into view when given.
    func openWorkspace(id: String, focusSessionKey: String? = nil) {
        section = .workspaces
        workspaces?.open(id: id, focusSessionKey: focusSessionKey)
    }

    /// Opens the page that owns a PTY session, as the web's
    /// `attentionSurfaceOf` routes it: a workspace's agent or panes go to the
    /// Workspaces page, `tab:terminal/…` panes to the Terminal page. False for
    /// an id neither owns.
    @discardableResult
    func openTerminalSession(_ key: String) -> Bool {
        if key.hasPrefix(agentSessionPrefix) {
            openWorkspace(id: String(key.dropFirst(agentSessionPrefix.count)), focusSessionKey: key)
            return true
        }
        let surface = key.split(separator: "/", maxSplits: 1).first.map(String.init) ?? ""
        if surface.hasPrefix("ws:") {
            openWorkspace(id: String(surface.dropFirst(3)), focusSessionKey: key)
            return true
        }
        if surface == "tab:terminal", terminals?.focus(sessionKey: key) == true {
            section = .terminal
            return true
        }
        return false
    }

    func openSettings(tab: String? = nil) {
        section = .settings
        if let tab { settings?.open(tab: tab) }
    }

    /// Follows an in-app `yarvis://` link from a reply or an artifact. False
    /// when the link isn't one this app knows, so the caller can leave it inert.
    @discardableResult
    func open(link: URL) -> Bool {
        guard link.scheme == "yarvis", let place = YarvisPlace(link) else { return false }
        switch place {
        case .workspace(let id): openWorkspace(id: id)
        case .tab(let name):
            if let page = Section(rawValue: name) {
                section = page
            } else {
                showWebUI()
            }
        case .settings(let tab): openSettings(tab: tab)
        case .artifact, .setup, .tour: return false
        }
        return true
    }

    func openInBrowser() {
        if let server { NSWorkspace.shared.open(server) }
    }
}
