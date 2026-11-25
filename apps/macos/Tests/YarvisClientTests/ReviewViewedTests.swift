import Foundation
import Testing
@testable import YarvisClient

private let viewedBase = URL(string: "https://yarvis.test")!
private let gh = PrRef.github(owner: "octo", repo: "repo", number: 7)
private let az = PrRef.azure(org: "acme", project: "Shop", repo: "web", prId: 42)

@Suite struct ReviewViewedTests {
    @Test func writesNothingForAPathAlreadyMarked() {
        #expect(viewedChanges(["a.ts"], paths: ["a.ts", "b.ts", "b.ts"], viewed: true) == ["b.ts"])
        #expect(viewedChanges(["a.ts"], paths: ["a.ts", "c.ts"], viewed: false) == ["a.ts"])
        #expect(viewedChanges(["a.ts"], paths: ["a.ts"], viewed: true).isEmpty)
    }

    @Test func marksEachPathWithOneRequestAndReturnsTheFailures() async throws {
        let counter = CallCounter()
        let (session, id) = StubProtocol.session { _, _ in
            counter.next() == 2 ? (502, Data("nope".utf8)) : (200, Data("{}".utf8))
        }
        let client = YarvisClient(baseURL: viewedBase, token: "t", session: session)
        let failed = await markManyViewed(client, gh, paths: ["a.ts", "b.ts", "c.ts"], viewed: true)
        #expect(failed == ["b.ts"])
        let requests = StubProtocol.recorded(id)
        #expect(requests.count == 3)
        let bodies = requests.compactMap { bodyJSON($0.1) }
        #expect(bodies.map { $0["path"]?.stringValue } == ["a.ts", "b.ts", "c.ts"])
        #expect(requests.allSatisfy { $0.0.url?.path.hasSuffix("/api/github/pr/octo/repo/7/viewed") == true })
    }

    @Test func azureHasNothingToWrite() async {
        let (session, id) = StubProtocol.session { _, _ in (200, Data("{}".utf8)) }
        let client = YarvisClient(baseURL: viewedBase, token: "t", session: session)
        #expect(await markManyViewed(client, az, paths: ["a.ts"], viewed: true).isEmpty)
        #expect(StubProtocol.recorded(id).isEmpty)
    }

    @Test func azureSetsAreKeptPerPr() {
        let other = PrRef.azure(org: "acme", project: "Shop", repo: "web", prId: 99)
        #expect(azureViewedKey(az) != azureViewedKey(other))
        #expect(azureViewedKey(az) == "review.viewed.az:acme/Shop/web/42")
    }

    @Test func rollsBackARejectedPathOnlyWhileItIsTheLatestMark() {
        var intents = ViewedIntents()
        let first = intents.record(["a.ts", "b.ts"])
        let shown: Set<String> = ["a.ts", "b.ts"]
        // b.ts was unmarked and marked again after the first write started.
        _ = intents.record(["b.ts"])
        #expect(intents.rollingBack(shown, failed: ["a.ts", "b.ts"], viewed: true, token: first) == ["b.ts"])
        let unmark = intents.record(["c.ts"])
        #expect(intents.rollingBack([], failed: ["c.ts"], viewed: false, token: unmark) == ["c.ts"])
    }

    @Test func failureMessagesCountTheFiles() {
        #expect(viewedFailureMessage([], viewed: true) == nil)
        #expect(viewedFailureMessage(["a.ts"], viewed: true) == "Could not mark a.ts viewed")
        #expect(viewedFailureMessage(["a", "b"], viewed: false) == "Could not mark 2 files unviewed")
    }
}

private final class CallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0

    func next() -> Int {
        lock.withLock {
            n += 1
            return n
        }
    }
}
