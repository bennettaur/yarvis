import Foundation

// Progress of the agent runs the Review tabs follow over SSE, folded from
// their events. Pure, so the order and replay rules are tested without a stream.

/// A re-review run as its events tell it: the latest thing it did, and how it ended.
public struct RereviewProgress: Sendable, Equatable {
    public var activity: String?
    public var steps = 0
    /// "succeeded", "failed" or "cancelled", once the run's `done` arrives.
    public var finished: String?
    public var error: String?

    public init() {}
}

public func reduceRereviewProgress(_ progress: RereviewProgress, _ event: AgentRunEvent) -> RereviewProgress {
    var next = progress
    switch event {
    case .tool(_, let name, let summary, _):
        next.steps += 1
        next.activity = summary.isEmpty ? name : "\(name) \(summary)"
    case .status(let message):
        next.activity = message
    case .error(let message):
        next.error = message
    case .done(let status):
        next.finished = status
    default:
        break
    }
    return next
}

/// A mutation pass as it is going: where it is, and each result as it lands.
public struct MutationProgress: Sendable, Equatable {
    public var phase = "copying"
    public var baselines: [BaselineResult] = []
    public var controls: [MutantResult] = []
    public var mutants: [MutantResult] = []
    /// How many mutants the run will try, once it has said.
    public var total: Int?
    /// What the planning or explaining agent is doing now.
    public var activity: String?
    public var error: String?
    /// Set by the pass's last event.
    public var finished: String?
    /// The stream closed or failed, with or without that last event.
    public var streamEnded = false

    public init() {}
}

/// The phases in order, for the progress list; "done" isn't a step.
public let mutationPhases = ["copying", "planning", "baseline", "control", "mutants", "explaining"]

public let mutationPhaseLabels: [String: String] = [
    "copying": "Copying the checkout",
    "planning": "Planning mutants",
    "baseline": "Running the tests as they are",
    "control": "Checking the tests notice a blatant change",
    "mutants": "Testing mutants",
    "explaining": "Explaining survivors",
    "done": "Done",
]

/// Results land once each; a replayed stream mustn't count one twice.
private func upsert<T: Identifiable>(_ list: [T], _ item: T) -> [T] {
    var list = list
    if let at = list.firstIndex(where: { $0.id == item.id }) { list[at] = item } else { list.append(item) }
    return list
}

public func reduceMutationProgress(_ state: MutationProgress, _ event: MutationProgressEvent) -> MutationProgress {
    var next = state
    switch event {
    case .phase(let phase, _):
        next.phase = phase
        next.activity = nil
    case .agent(_, let e):
        switch e {
        case .tool(_, let name, let summary, _): next.activity = "\(name) \(summary)".trimmingCharacters(in: .whitespaces)
        case .status(let message): next.activity = message
        default: break
        }
    case .baseline(let result):
        next.baselines = upsert(next.baselines, result)
    case .mutant(let result, _, let total, let control):
        if control {
            next.controls = upsert(next.controls, result)
        } else {
            next.mutants = upsert(next.mutants, result)
            next.total = total
        }
    case .error(let message):
        next.error = message
    case .done(let status):
        next.phase = "done"
        next.finished = status
        next.activity = nil
    }
    return next
}
