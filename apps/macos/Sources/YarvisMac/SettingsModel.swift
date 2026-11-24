import Foundation
import Observation
import YarvisClient

/// The Settings page: devices, the account, and the vault.
@MainActor @Observable
final class SettingsModel {
    private unowned let app: AppModel
    private let client: YarvisClient

    /// True while the server's vault is locked, which keeps the sidecar (and
    /// so chat and workspaces) down until it's unlocked.
    var vaultNeedsUnlock: Bool { false }

    init(app: AppModel, client: YarvisClient) {
        self.app = app
        self.client = client
    }

    func stop() {}

    func handle(_ event: ServerEvent) {}

    func resync() {}

    /// Shows a Settings tab by the web's key, such as `devices`.
    func open(tab: String) {}
}
