import Foundation
import Observation
import YarvisClient

/// The Terminal page: one surface of shell tabs.
/// Workspace agents and review sessions live on the Workspaces page instead.
@MainActor @Observable
final class TerminalsModel {
    static let storageKey = "tab:terminal"

    let surface: TerminalSurfaceModel

    init(app: AppModel, client: YarvisClient) {
        surface = TerminalSurfaceModel(app: app, client: client, storageKey: Self.storageKey, cwd: nil,
                                       opensShellTab: true)
    }

    func stop() {
        surface.stop()
    }

    /// The layout is this client's own and each pane holds its own socket, so
    /// no server event changes what the page shows.
    func handle(_ event: ServerEvent) {}

    func resync() {}

    /// Brings a `tab:terminal/…` pane into view, for an attention item.
    @discardableResult
    func focus(sessionKey: String) -> Bool {
        surface.focus(sessionKey: sessionKey)
    }
}
