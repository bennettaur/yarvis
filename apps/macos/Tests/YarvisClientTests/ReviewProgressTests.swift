import Foundation
import Testing
@testable import YarvisClient

private func mutant(_ id: String, outcome: String = "killed") -> MutantResult {
    MutantResult(id: id, path: "a.ts", line: 1, oldText: "a", newText: "b", description: "flip", rationale: "",
                 testCommandId: nil, testFiles: [], outcome: outcome, durationMs: nil, testCount: nil, evidence: "")
}

private func fold(_ events: [MutationProgressEvent]) -> MutationProgress {
    events.reduce(MutationProgress(), reduceMutationProgress)
}

@Suite struct ReviewProgressTests {
    @Test func followsThePhasesAndClearsTheAgentsActivityBetweenThem() {
        var p = fold([.phase("planning", agentRunId: "r"),
                      .agent(phase: "planning", event: .tool(id: "t", name: "Read", summary: "src/a.ts", subagentId: nil))])
        #expect(p.phase == "planning")
        #expect(p.activity == "Read src/a.ts")
        p = reduceMutationProgress(p, .agent(phase: "planning", event: .status("Thinking")))
        #expect(p.activity == "Thinking")
        p = reduceMutationProgress(p, .phase("baseline", agentRunId: nil))
        #expect(p.phase == "baseline")
        #expect(p.activity == nil)
    }

    @Test func keepsTheControlApartAndCountsTowardTheTotal() {
        let p = fold([.mutant(mutant("c"), index: 0, total: 1, control: true),
                      .mutant(mutant("m1"), index: 0, total: 3, control: false)])
        #expect(p.controls.map(\.id) == ["c"])
        #expect(p.mutants.map(\.id) == ["m1"])
        #expect(p.total == 3)
    }

    @Test func countsAResultOnceWhenTheStreamReplaysIt() {
        let p = fold([.mutant(mutant("m1", outcome: "survived"), index: 0, total: 2, control: false),
                      .mutant(mutant("m1", outcome: "killed"), index: 0, total: 2, control: false)])
        #expect(p.mutants.count == 1)
        #expect(p.mutants[0].outcome == "killed")
    }

    @Test func endsOnDoneAndKeepsAnError() {
        let p = fold([.agent(phase: "explaining", event: .status("x")), .error("boom"), .done(status: "failed")])
        #expect(p.phase == "done")
        #expect(p.finished == "failed")
        #expect(p.error == "boom")
        #expect(p.activity == nil)
    }

    @Test func rereviewCountsToolStepsAndRecordsTheEnd() {
        let events: [AgentRunEvent] = [
            .tool(id: "1", name: "Read", summary: "", subagentId: nil),
            .tool(id: "2", name: "Grep", summary: "cache", subagentId: nil),
            .text("ignored", subagentId: nil),
            .error("slow"),
            .done(status: "succeeded"),
        ]
        let p = events.reduce(RereviewProgress(), reduceRereviewProgress)
        #expect(p.steps == 2)
        #expect(p.activity == "Grep cache")
        #expect(p.error == "slow")
        #expect(p.finished == "succeeded")
    }
}
