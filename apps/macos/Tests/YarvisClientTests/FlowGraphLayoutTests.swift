import Foundation
import Testing
@testable import YarvisClient

private func graph(_ edges: [(String, String)], extra: [String] = []) -> PrGuideGraph {
    var ids: [String] = []
    for id in edges.flatMap({ [$0.0, $0.1] }) + extra where !ids.contains(id) { ids.append(id) }
    return PrGuideGraph(nodes: ids.map { PrGraphNode(id: $0, kind: "function") },
                        edges: edges.map { PrGraphEdge(from: $0.0, to: $0.1, kind: "calls") })
}

@Suite struct FlowGraphLayoutTests {
    @Test func putsEachNodeRightOfEverythingThatReachesItByTheLongestRoute() {
        #expect(nodeColumns(graph([("route", "service"), ("service", "store"), ("route", "store")]))
            == ["route": 0, "service": 1, "store": 2])
    }

    @Test func keepsACycleWithinTheGraphsColumns() {
        #expect(nodeColumns(graph([("a", "b"), ("b", "a")])) == ["a": 0, "b": 1])
    }

    @Test func ignoresAnEdgeWithAnEndOutsideTheGraph() {
        var g = graph([], extra: ["a", "b"])
        g.edges += [PrGraphEdge(from: "a", to: "missing", kind: "calls"), PrGraphEdge(from: "missing", to: "b", kind: "calls")]
        #expect(nodeColumns(g) == ["a": 0, "b": 0])
    }

    @Test func placesBoxesByColumnStackingThoseThatShareOne() {
        let layout = FlowGraphLayout(graph([("route", "store"), ("route", "cache")]))
        #expect(layout.boxes.map { [$0.x, $0.y] } == [[0, 0], [380, 0], [380, 120]])
        #expect(layout.arrows == [FlowGraphArrow(from: 0, to: 1, label: "calls"), FlowGraphArrow(from: 0, to: 2, label: "calls")])
        #expect(layout.width == 620)
        #expect(layout.height == 200)
    }

    @Test func keepsModelWrittenLabelsToOneLineWithTheLocationUnderIt() {
        var node = PrGraphNode(id: "load\nfake.ts:1", kind: "fn\u{7}", file: "src/a.ts", line: 4, endLine: 9)
        #expect(flowNodeLabel(node).title == "load fake.ts:1 · fn")
        #expect(flowNodeLabel(node).location == "src/a.ts:4-9")
        node.endLine = 4
        #expect(flowNodeLabel(node).location == "src/a.ts:4")
        node.line = nil
        #expect(flowNodeLabel(node).location == "src/a.ts")
        node.file = nil
        #expect(flowNodeLabel(node).location == nil)
    }
}
