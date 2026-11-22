import AppKit
import Foundation
import Observation
import YarvisClient

enum Section: String, Hashable, CaseIterable {
    case chat, attention, terminals

    var title: String {
        switch self {
        case .chat: return "Chat"
        case .attention: return "Attention"
        case .terminals: return "Terminals"
        }
    }

    var symbol: String {
        switch self {
        case .chat: return "bubble.left.and.bubble.right"
        case .attention: return "bell"
        case .terminals: return "terminal"
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
    var section: Section = .chat
    /// A code prompt is up while this is set; the sheet resumes it.
    var codeRequest: CheckedContinuation<String?, Never>?

    private(set) var chat: ChatModel?
    private(set) var attention: AttentionModel?
    private(set) var terminals: TerminalsModel?
    private var events: EventStream?
    private var eventsTask: Task<Void, Never>?

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
        let client = YarvisClient(baseURL: server, token: token) { [weak self] in
            Task { @MainActor in self?.serverSignedOut() }
        }
        self.server = server
        self.client = client
        self.device = device
        chat = ChatModel(app: self, client: client)
        attention = AttentionModel(app: self, client: client)
        terminals = TerminalsModel(app: self, client: client)
        attention?.start()
        startEvents(server: server, token: token)
        if device == nil {
            Task { self.device = try? await client.me() }
        }
    }

    private func startEvents(server: URL, token: String) {
        let events = EventStream(baseURL: server, token: token)
        self.events = events
        eventsTask = Task { [weak self] in
            await events.start()
            for await update in events.updates {
                guard let self else { return }
                switch update {
                case .event(let e): self.handle(e)
                case .lagged: self.attention?.reloadApprovals()
                case .signedOut: self.serverSignedOut()
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
            chat?.reloadSessions()
            attention?.reload()
        // They can arrive in either order, so the list is read again rather
        // than patched from them.
        case "pty.started", "pty.exited":
            terminals?.reload()
        default:
            break
        }
    }

    /// True from the user pressing Sign Out until the app has forgotten the token.
    private var signingOut = false

    /// The user's Sign Out: revokes this device on the server, then forgets
    /// the token here whatever the answer.
    func signOut() async {
        guard let client, !signingOut else { return }
        signingOut = true
        defer { signingOut = false }
        // Sockets close first, so the 4401 the revoke sends them isn't taken
        // for the server signing this device out.
        stopConnections()
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
    func serverSignedOut() {
        guard !signingOut else { return }
        forget(reason: Self.revokedMessage)
    }

    private func stopConnections() {
        eventsTask?.cancel()
        if let events { Task { await events.stop() } }
        attention?.stop()
        chat?.stop()
        terminals?.stop()
    }

    /// Drops the token and everything signed in with it, and shows sign-in.
    private func forget(reason: String?) {
        guard let server else { return }
        TokenStore.delete(server: server)
        stopConnections()
        events = nil
        client = nil
        device = nil
        chat = nil
        attention = nil
        terminals = nil
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

    func openInBrowser() {
        if let server { NSWorkspace.shared.open(server) }
    }
}
