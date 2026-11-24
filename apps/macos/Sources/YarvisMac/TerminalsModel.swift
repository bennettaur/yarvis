import AppKit
import Foundation
import Observation
import SwiftTerm
import YarvisClient

/// The Terminals section: every PTY session the server lists, and each active
/// workspace, so a workspace with no agent running can start one.
@MainActor @Observable
final class TerminalsModel {
    private unowned let app: AppModel
    private let client: YarvisClient

    var workspaces: [WorkspaceSummary] = []
    var sessions: [PtySession] = []
    /// Terminals opened here that the server hasn't listed yet. A shell
    /// starts on first attach, and the next list picks it up.
    private(set) var pending: [String] = []
    var selectedId: String?
    var error: String?
    /// One live view per attached session, so switching keeps scrollback and
    /// the socket.
    private var controllers: [String: TerminalController] = [:]

    init(app: AppModel, client: YarvisClient) {
        self.app = app
        self.client = client
        reload()
    }

    func stop() {
        controllers.values.forEach { $0.stop() }
        controllers = [:]
    }

    var shells: [PtySession] { sessions.filter { $0.kind == "shell" } }
    var reviews: [PtySession] { sessions.filter { $0.kind == "review" && $0.running } }

    func session(_ id: String) -> PtySession? { sessions.first { $0.id == id } }

    func title(_ s: PtySession) -> String {
        terminalTitle(s, workspaceNames: Dictionary(workspaces.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a }))
    }

    func reload() {
        Task { await refresh() }
    }

    func handle(_ event: ServerEvent) {
        // These two can arrive in either order, so read the list again
        // rather than patch it from them.
        if event.kind == "pty.started" || event.kind == "pty.exited" { reload() }
    }

    func resync() {
        reload()
    }

    /// Brings a `tab:terminal/…` pane into view, for an attention item.
    @discardableResult
    func focus(sessionKey: String) -> Bool {
        select(sessionKey)
    }

    private var refreshes = 0

    func refresh() async {
        refreshes += 1
        let generation = refreshes
        var active: [WorkspaceSummary]?
        var listed: [PtySession]?
        var problem: String?
        do {
            active = try await client.workspaces().filter { $0.status == "active" }
        } catch {
            problem = error.localizedDescription
        }
        do {
            listed = try await client.ptySessions()
        } catch YarvisError.http(status: 403, _, _) {
            listed = []
            problem = "This device can't open terminals: it has no terminal scope."
        } catch {
            problem = error.localizedDescription
        }
        // Reads overlap when events come close together, and an older answer
        // can land last. Showing it could put Attach on an agent that ended.
        guard generation == refreshes else { return }
        if let active { workspaces = active }
        if let listed {
            sessions = listed
            pending.removeAll { id in listed.contains { $0.id == id } }
        }
        error = problem
    }

    /// Opens a session by id. Returns false for an id that isn't listed,
    /// opened here, a workspace's agent, or shaped like a terminal pane: the id can come from an attention item,
    /// and attaching to an unknown one spawns a shell there.
    @discardableResult
    func select(_ id: String) -> Bool {
        let known = session(id) != nil || pending.contains(id) || workspaces.contains { $0.agentSessionId == id }
        guard known || isTerminalPaneId(id, workspaceIds: workspaces.map(\.id)) else { return false }
        if !known { pending.append(id) }
        selectedId = id
        return true
    }

    func newTerminal() {
        let stamp = String(Int(Date().timeIntervalSince1970 * 1000), radix: 36)
        let id = "tab:terminal/t\(stamp)/p\(stamp)"
        pending.append(id)
        selectedId = id
    }

    func kill(_ id: String) {
        pending.removeAll { $0 == id }
        controllers.removeValue(forKey: id)?.stop()
        if selectedId == id { selectedId = nil }
        Task {
            do {
                try await app.withFreshCode { [client] in try await client.ptyKill(id) }
            } catch {
                self.error = error.localizedDescription
            }
            await refresh()
        }
    }

    func startAgent(_ ws: WorkspaceSummary) {
        Task {
            do {
                try await app.withFreshCode { [client] in try await client.startAgentSession(workspace: ws) }
                // Listed as running before it's selected, or the Start button would stay up.
                await refresh()
                selectedId = ws.agentSessionId
            } catch {
                self.error = error.localizedDescription
                await refresh()
            }
        }
    }

    /// Attaching to an agent id with nothing running would spawn a plain
    /// shell under it, so a stopped agent shows a Start button instead.
    func canAttach(_ id: String) -> Bool {
        !id.hasPrefix(agentSessionPrefix) || session(id)?.running == true
    }

    func controller(for id: String) -> TerminalController {
        if let existing = controllers[id] { return existing }
        // No `cwd`: the server may be another machine, so a shell it spawns
        // opens in its own default folder.
        let controller = TerminalController(app: app, client: client, sessionId: id,
                                            agentSession: id.hasPrefix(agentSessionPrefix))
        controllers[id] = controller
        return controller
    }
}

/// One SwiftTerm view wired to one `PtyConnection`.
@MainActor
final class TerminalController: NSObject, TerminalViewDelegate {
    let view: TerminalView
    private let pty: PtyConnection
    private var pump: Task<Void, Never>?
    private unowned let app: AppModel
    private let client: YarvisClient

    /// `agentSession` reconnects only while the agent still runs.
    init(app: AppModel, client: YarvisClient, sessionId: String, agentSession: Bool) {
        self.app = app
        self.client = client
        view = TerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 500))
        let terminal = view.terminalDimensions
        var mayReconnect: (@Sendable () async -> Bool)?
        if agentSession {
            mayReconnect = { (try? await client.ptyExists(sessionId)) ?? false }
        }
        pty = PtyConnection(baseURL: client.baseURL, token: client.token, sessionId: sessionId,
                            cols: UInt16(clamping: terminal.cols), rows: UInt16(clamping: terminal.rows),
                            mayReconnect: mayReconnect)
        super.init()
        view.terminalDelegate = self
        let pty = self.pty
        pump = Task { [weak self] in
            await pty.start()
            for await update in pty.updates {
                self?.apply(update)
            }
        }
    }

    func stop() {
        pump?.cancel()
        let pty = self.pty
        Task { await pty.stop() }
    }

    private func apply(_ update: PtyConnection.Update) {
        switch update {
        case .reset:
            // RIS, so a snapshot replays onto a clean screen.
            view.feed(text: "\u{1b}c")
        case .output(let bytes):
            view.feed(byteArray: ArraySlice(bytes))
        case .exit(let code):
            view.feed(text: "\r\n[process exited\(code.map { " with code \($0)" } ?? "")]\r\n")
        case .error(let message):
            view.feed(text: "\r\n[\(message)]\r\n")
        case .refused(let code):
            view.feed(text: "\r\n[the server closed the terminal (\(code))]\r\n")
        case .signedOut:
            app.serverSignedOut(client: client)
        case .reconnecting, .size:
            break
        }
    }

    // MARK: TerminalViewDelegate

    nonisolated func send(source: TerminalView, data: ArraySlice<UInt8>) {
        let bytes = Data(data)
        Task { await pty.send(input: bytes) }
    }

    nonisolated func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        Task { await pty.resize(cols: UInt16(clamping: newCols), rows: UInt16(clamping: newRows)) }
    }

    nonisolated func setTerminalTitle(source: TerminalView, title: String) {}
    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    nonisolated func scrolled(source: TerminalView, position: Double) {}
    nonisolated func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    nonisolated func bell(source: TerminalView) {
        Task { @MainActor in NSSound.beep() }
    }

    /// OSC 52 writes are ignored: any program in the session, or a file it
    /// prints, could put a command on the clipboard for the next paste.
    nonisolated func clipboardCopy(source: TerminalView, content: Data) {}

    /// Only web links open: terminal output can come from anywhere.
    nonisolated func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
        Task { @MainActor in NSWorkspace.shared.open(url) }
    }

    /// Takes over the PTY size when the user clicks into this terminal.
    func focused() {
        let pty = self.pty
        Task { await pty.focus() }
    }
}
