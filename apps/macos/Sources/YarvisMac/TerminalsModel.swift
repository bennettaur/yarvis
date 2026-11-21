import AppKit
import Foundation
import Observation
import SwiftTerm
import YarvisClient

/// A terminal this app opened. Its id has the web's Terminal-tab shape
/// (`tab:terminal/<tab>/<pane>`), so attention items raised from it open it.
struct TerminalTab: Codable, Hashable, Identifiable {
    var id: String
    var title: String
}

/// The sessions the Terminals section lists. The server has no route that
/// lists live PTYs, so this is each workspace's agent session plus the
/// terminals this app opened, kept per server in UserDefaults.
@MainActor @Observable
final class TerminalsModel {
    private unowned let app: AppModel
    private let client: YarvisClient

    var workspaces: [WorkspaceSummary] = []
    /// Which workspace agent sessions have a running shell.
    var agentRunning: [String: Bool] = [:]
    var tabs: [TerminalTab] = []
    var selectedId: String?
    var error: String?
    /// One live view per attached session, so switching keeps scrollback and
    /// the socket.
    private var hosts: [String: TerminalController] = [:]

    private var tabsKey: String { "terminals.\(client.baseURL.absoluteString)" }

    init(app: AppModel, client: YarvisClient) {
        self.app = app
        self.client = client
        if let data = UserDefaults.standard.data(forKey: tabsKey),
           let saved = try? JSONDecoder().decode([TerminalTab].self, from: data) {
            tabs = saved
        }
        reload()
    }

    func stop() {
        hosts.values.forEach { $0.stop() }
        hosts = [:]
    }

    func reload() {
        Task {
            do {
                workspaces = try await client.workspaces().filter { $0.status == "active" }
                for ws in workspaces {
                    agentRunning[ws.agentSessionId] = try await client.ptyExists(ws.agentSessionId)
                }
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    func select(_ id: String) {
        selectedId = id
        if id.hasPrefix("tab:terminal/"), !tabs.contains(where: { $0.id == id }) {
            tabs.append(TerminalTab(id: id, title: "Terminal"))
            saveTabs()
        }
    }

    func newTerminal() {
        let stamp = String(Int(Date().timeIntervalSince1970 * 1000), radix: 36)
        let tab = TerminalTab(id: "tab:terminal/t\(stamp)/p\(stamp)", title: "Terminal \(tabs.count + 1)")
        tabs.append(tab)
        saveTabs()
        selectedId = tab.id
    }

    func close(_ tab: TerminalTab) {
        tabs.removeAll { $0.id == tab.id }
        saveTabs()
        hosts.removeValue(forKey: tab.id)?.stop()
        if selectedId == tab.id { selectedId = nil }
        Task { try? await client.ptyKill(tab.id) }
    }

    func startAgent(_ ws: WorkspaceSummary) {
        Task {
            do {
                try await app.fresh { [client] in try await client.startAgentSession(workspace: ws) }
                agentRunning[ws.agentSessionId] = true
                selectedId = ws.agentSessionId
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    func sessionExited(_ id: String) {
        if agentRunning[id] != nil { agentRunning[id] = false }
    }

    /// Attaching to an agent id with nothing running would spawn a plain
    /// shell under it, so a stopped agent shows a Start button instead.
    func canAttach(_ id: String) -> Bool {
        !id.hasPrefix("ws-claude:") || agentRunning[id] == true
    }

    func controller(for id: String) -> TerminalController {
        if let host = hosts[id] { return host }
        let host = TerminalController(app: app, client: client, sessionId: id,
                                      cwd: FileManager.default.homeDirectoryForCurrentUser.path)
        hosts[id] = host
        return host
    }

    private func saveTabs() {
        UserDefaults.standard.set(try? JSONEncoder().encode(tabs), forKey: tabsKey)
    }
}

/// One SwiftTerm view wired to one `PtyConnection`.
@MainActor
final class TerminalController: NSObject, TerminalViewDelegate {
    let view: TerminalView
    private let pty: PtyConnection
    private var pump: Task<Void, Never>?
    private unowned let app: AppModel
    var status: String?

    init(app: AppModel, client: YarvisClient, sessionId: String, cwd: String?) {
        self.app = app
        view = TerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 500))
        let terminal = view.terminalDimensions
        pty = PtyConnection(baseURL: client.baseURL, token: client.token, sessionId: sessionId,
                            cols: UInt16(clamping: terminal.cols), rows: UInt16(clamping: terminal.rows), cwd: cwd)
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
        case .closed(let code):
            view.feed(text: "\r\n[the server closed the terminal (\(code))]\r\n")
        case .signedOut:
            app.signOut(reason: "This device was signed out by the server.")
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

    nonisolated func clipboardCopy(source: TerminalView, content: Data) {
        guard let text = String(data: content, encoding: .utf8) else { return }
        Task { @MainActor in
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
    }

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
