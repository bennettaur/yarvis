import Foundation

/// Where this Mac keeps an Azure PR's viewed paths: Azure has no viewed
/// flag of its own, so the set lives per PR in the app's defaults.
public func azureViewedKey(_ ref: PrRef) -> String { "review.viewed.\(ref.key)" }

/// The paths whose state a mark would change, each once and in order.
/// Already-marked paths are left out, so nothing is written for them.
public func viewedChanges(_ current: Set<String>, paths: [String], viewed: Bool) -> [String] {
    var seen = Set<String>()
    return paths.filter { current.contains($0) != viewed && seen.insert($0).inserted }
}

public func applyingViewed(_ current: Set<String>, paths: [String], viewed: Bool) -> Set<String> {
    viewed ? current.union(paths) : current.subtracting(paths)
}

/// The latest mark asked for per path, so a slow write that fails can't
/// undo a later one: its rollback only applies while it is still the latest.
public struct ViewedIntents: Sendable {
    private var latest: [String: Int] = [:]
    private var counter = 0

    public init() {}

    /// Records a mark of `paths`, returning its token.
    public mutating func record(_ paths: [String]) -> Int {
        counter += 1
        for p in paths { latest[p] = counter }
        return counter
    }

    public func isLatest(_ path: String, token: Int) -> Bool { latest[path] == token }

    /// The set after `failed` writes of `viewed` are rolled back, skipping
    /// any path marked again since.
    public func rollingBack(_ current: Set<String>, failed: [String], viewed: Bool, token: Int) -> Set<String> {
        applyingViewed(current, paths: failed.filter { isLatest($0, token: token) }, viewed: !viewed)
    }
}

/// Writes each mark on GitHub, one request per path in order (GitHub takes
/// a mutation per file), and returns the paths it couldn't save. Azure has
/// nothing to write: its set is kept locally.
public func markManyViewed(_ client: YarvisClient, _ ref: PrRef, paths: [String], viewed: Bool) async -> [String] {
    if case .azure = ref { return [] }
    var failed: [String] = []
    for path in paths {
        do {
            try await client.setFileViewed(ref, path: path, viewed: viewed)
        } catch {
            failed.append(path)
        }
    }
    return failed
}

/// What the nav says when marks failed.
public func viewedFailureMessage(_ failed: [String], viewed: Bool) -> String? {
    let verb = viewed ? "viewed" : "unviewed"
    switch failed.count {
    case 0: return nil
    case 1: return "Could not mark \(failed[0]) \(verb)"
    default: return "Could not mark \(failed.count) files \(verb)"
    }
}
