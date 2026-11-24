import AppKit
import Foundation
import SwiftTerm
import SwiftUI
import YarvisClient

/// One SwiftTerm view wired to one `PtyConnection`.
@MainActor
final class TerminalController: NSObject, TerminalViewDelegate {
    let sessionId: String
    let view: TerminalView
    private let pty: PtyConnection
    private var pump: Task<Void, Never>?
    private var pendingResize: Task<Void, Never>?
    private unowned let app: AppModel
    private let client: YarvisClient
    /// Set by `.reset`: the next output is a snapshot being replayed.
    private var snapshotNext = false
    /// True while SwiftTerm's replies to a replayed snapshot are still queued.
    private var replaying = false
    /// True once the connection has stopped for good (exit, a refusal, or a
    /// server-started session that ended). It never attaches again.
    private(set) var ended = false
    /// Long enough that a window drag sends one resize, not dozens.
    private static let resizeDebounce = Duration.milliseconds(80)

    /// `cwd` is where the shell starts if this attach spawns one.
    init(app: AppModel, client: YarvisClient, sessionId: String, cwd: String? = nil) {
        self.app = app
        self.client = client
        self.sessionId = sessionId
        view = TerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 500))
        TerminalAppearance.shared.attach(view)
        let terminal = view.terminalDimensions
        var mayReconnect: (@Sendable () async -> Bool)?
        if isServerStartedSession(sessionId) {
            mayReconnect = { (try? await client.ptyExists(sessionId)) ?? false }
        }
        pty = PtyConnection(baseURL: client.baseURL, token: client.token, sessionId: sessionId,
                            cols: UInt16(clamping: terminal.cols), rows: UInt16(clamping: terminal.rows),
                            cwd: cwd, mayReconnect: mayReconnect)
        super.init()
        view.terminalDelegate = self
        let pty = self.pty
        pump = Task { [weak self] in
            await pty.start()
            for await update in pty.updates {
                self?.apply(update)
            }
            self?.ended = true
        }
    }

    func stop() {
        pump?.cancel()
        pendingResize?.cancel()
        let pty = self.pty
        Task { await pty.stop() }
    }

    /// Bytes for the PTY that skip SwiftTerm's key encoding.
    func sendRaw(_ text: String) {
        let pty = self.pty
        let bytes = Data(text.utf8)
        Task { await pty.send(input: bytes) }
    }

    func makeFirstResponder() {
        view.window?.makeFirstResponder(view)
    }

    private func apply(_ update: PtyConnection.Update) {
        switch update {
        case .reset:
            // RIS, so a snapshot replays onto a clean screen.
            view.feed(text: "\u{1b}c")
            snapshotNext = true
        case .output(let bytes):
            if snapshotNext {
                snapshotNext = false
                // The snapshot holds the program's old queries (DA, DECRQM, OSC
                // colour), and SwiftTerm answers them again. Those answers are
                // stale and would reach the program as typed input. SwiftTerm
                // queues them on the main queue while parsing, so they all run
                // before this flag is cleared.
                replaying = true
                view.feed(byteArray: ArraySlice(bytes))
                DispatchQueue.main.async { [weak self] in self?.replaying = false }
            } else {
                view.feed(byteArray: ArraySlice(bytes))
            }
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
        MainActor.assumeIsolated {
            guard !replaying else { return }
            let pty = self.pty
            Task { await pty.send(input: bytes) }
        }
    }

    nonisolated func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        let cols = UInt16(clamping: newCols)
        let rows = UInt16(clamping: newRows)
        MainActor.assumeIsolated {
            pendingResize?.cancel()
            let pty = self.pty
            pendingResize = Task {
                do { try await Task.sleep(for: Self.resizeDebounce) } catch { return }
                await pty.resize(cols: cols, rows: rows)
            }
        }
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

    /// Terminal output can come from anywhere, so only web links open.
    nonisolated func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link) else { return }
        Task { @MainActor in openWebLink(url) }
    }

    /// Takes over the PTY size when the user clicks into this terminal.
    func focused() {
        let pty = self.pty
        Task { await pty.focus() }
    }
}

/// Hosts a controller's long-lived `TerminalView`.
struct TerminalHost: NSViewRepresentable {
    let controller: TerminalController
    /// Moves keyboard focus into the terminal when it appears.
    var takesFocus = true
    /// Called on a click into the terminal.
    var onClick: (() -> Void)?

    func makeNSView(context: Context) -> NSView {
        let container = FocusReportingView()
        container.onFocus = { [controller, onClick] in
            controller.focused()
            onClick?()
        }
        let view = controller.view
        view.removeFromSuperview()
        view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            view.topAnchor.constraint(equalTo: container.topAnchor),
            view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        if takesFocus {
            DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        }
        return container
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        (nsView as? FocusReportingView)?.onFocus = { [controller, onClick] in
            controller.focused()
            onClick?()
        }
    }
}

/// Reports a click into the terminal, which takes over the PTY size.
final class FocusReportingView: NSView {
    var onFocus: (() -> Void)?

    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        if hit != nil, let event = NSApp.currentEvent, event.type == .leftMouseDown { onFocus?() }
        return hit
    }
}
