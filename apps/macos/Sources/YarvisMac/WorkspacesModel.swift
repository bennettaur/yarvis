import Foundation
import Observation
import YarvisClient

/// The Workspaces page: the workspace list and the selected workspace.
@MainActor @Observable
final class WorkspacesModel {
    private unowned let app: AppModel
    private let client: YarvisClient

    var workspaces: [WorkspaceSummary] = []
    var selectedId: String?
    var error: String?

    init(app: AppModel, client: YarvisClient) {
        self.app = app
        self.client = client
        resync()
    }

    func stop() {}

    func handle(_ event: ServerEvent) {}

    func resync() {
        Task {
            do {
                workspaces = try await client.workspaces()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// Selects a workspace, and brings `focusSessionKey` into view when given.
    func open(id: String, focusSessionKey: String?) {
        selectedId = id
    }
}
