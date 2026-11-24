import Foundation
import Observation
import SwiftUI
import YarvisClient

/// A tab kept at the front of a terminal surface by its owner, such as a
/// workspace's agent session. The owner decides what closing it does.
struct PinnedTerminalTab: Equatable, Identifiable {
    /// Stable within the surface, such as `agent`.
    let key: String
    var title: String
    /// The PTY id, such as `ws-claude:<workspaceId>`.
    let sessionId: String
    var id: String { key }
}

/// A set of terminal tabs with split panes, like the web's `TerminalTabs`.
/// The Terminal page has one (`tab:terminal`), and each workspace has its own
/// (`ws:<workspaceId>`). Pane PTY ids are `<storageKey>/<tabId>/<paneId>`, so
/// attention items can name the exact pane.
@MainActor @Observable
final class TerminalSurfaceModel {
    let storageKey: String
    /// The folder new shells start in; nil leaves it to the server.
    let cwd: String?
    /// Owner-managed tabs shown before the surface's own.
    var pinned: [PinnedTerminalTab] = []
    /// Called when the user closes a pinned tab.
    var onClosePinned: ((PinnedTerminalTab) -> Void)?
    var selectedKey: String?

    private unowned let app: AppModel
    private let client: YarvisClient
    private var controllers: [String: TerminalController] = [:]

    /// `opensShellTab` starts the surface with one shell tab, as the Terminal
    /// page does; a workspace's surface starts empty.
    init(app: AppModel, client: YarvisClient, storageKey: String, cwd: String?, opensShellTab: Bool) {
        self.app = app
        self.client = client
        self.storageKey = storageKey
        self.cwd = cwd
    }

    func stop() {
        controllers.values.forEach { $0.stop() }
        controllers = [:]
    }

    /// Brings the tab and pane running `sessionKey` into view. False when no
    /// tab here holds it.
    @discardableResult
    func focus(sessionKey: String) -> Bool {
        guard let tab = pinned.first(where: { $0.sessionId == sessionKey }) else { return false }
        selectedKey = tab.key
        return true
    }

    func controller(for sessionId: String) -> TerminalController {
        if let existing = controllers[sessionId] { return existing }
        let controller = TerminalController(app: app, client: client, sessionId: sessionId,
                                            agentSession: sessionId.hasPrefix(agentSessionPrefix))
        controllers[sessionId] = controller
        return controller
    }
}

struct TerminalSurfaceView: View {
    @Bindable var model: TerminalSurfaceModel

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $model.selectedKey) {
                ForEach(model.pinned) { Text($0.title).tag(Optional($0.key)) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(6)
            if let key = model.selectedKey ?? model.pinned.first?.key,
               let tab = model.pinned.first(where: { $0.key == key }) {
                TerminalHost(controller: model.controller(for: tab.sessionId)).id(tab.sessionId)
            } else {
                Spacer()
            }
        }
    }
}
