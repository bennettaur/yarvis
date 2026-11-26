import Foundation

/// A tab's per-PR state that has work to end: requests, streams, polls.
@MainActor
protocol ReviewTabModel: AnyObject {
    /// Cancels every task and stream the model runs. It may be used again after.
    func stop()
}

/// Per-PR state for the agent tabs of one open workspace, kept while a tab
/// isn't on screen so a slow request or a started run outlives switching
/// tabs. The workspace model owns one and stops it when the workspace closes.
@MainActor
final class ReviewTabModelStore {
    private var models: [String: any ReviewTabModel] = [:]

    /// The model of type `M` for `prId`, made on first use.
    func get<M: ReviewTabModel>(_ prId: String, make: () -> M) -> M {
        let key = "\(M.self):\(prId)"
        if let model = models[key] as? M { return model }
        let model = make()
        models[key] = model
        return model
    }

    /// Stops and drops every model.
    func stop() {
        for model in models.values { model.stop() }
        models = [:]
    }
}
