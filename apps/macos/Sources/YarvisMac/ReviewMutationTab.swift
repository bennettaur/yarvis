import SwiftUI
import YarvisClient

/// One PR's mutation testing: the stored pass, the one being followed, and
/// the start prompt. Kept per PR so a pass started here is still followed
/// after switching tabs.
@MainActor @Observable
final class ReviewMutationModel: ReviewTabModel {
    private let client: YarvisClient
    let workspaceId: String
    let prId: String

    private(set) var state: MutationTestingState?
    private(set) var loading = false
    private(set) var loadError: String?
    private(set) var config = MutationTestingConfig.defaults
    /// The pass this tab started, followed before the stored state says it runs.
    private(set) var startedId: String?
    private(set) var progress: MutationProgress?
    /// Non-nil while the start prompt is open: whether starting agrees to run the tests without a setup script.
    var confirming: Bool?
    private(set) var starting = false
    var actionError: String?

    private var followed: String?
    private var stream: Task<Void, Never>?
    /// The tab is showing; only then is a stream opened.
    private var attached = false
    private var tasks: [String: Task<Void, Never>] = [:]
    private var generation = 0

    init(client: YarvisClient, workspaceId: String, prId: String) {
        self.client = client
        self.workspaceId = workspaceId
        self.prId = prId
    }

    var run: MutationRun? { state?.run }

    var tab: MutationTabState {
        MutationTabState(run: run, startedId: startedId, progress: progress, blocked: state?.blocked != nil,
                         confirming: confirming != nil)
    }

    /// Runs `work` as the one task called `key`, cancelling the one before it.
    private func run(_ key: String, _ work: @escaping @MainActor () async -> Void) {
        tasks[key]?.cancel()
        tasks[key] = Task { await work() }
    }

    func load() {
        generation += 1
        let generation = generation
        loading = state == nil
        run("load") { [self] in
            do {
                let next = try await client.mutationTesting(workspaceId: workspaceId, prId: prId)
                guard generation == self.generation else { return }
                state = next
                loadError = nil
                follow()
            } catch {
                guard generation == self.generation else { return }
                loadError = error.localizedDescription
            }
            loading = false
        }
    }

    func loadConfig() {
        run("config") { [self] in if let c = try? await client.mutationTestingConfig() { config = c } }
    }

    /// The tab came on screen: follow the pass, if one is going.
    func attach() {
        attached = true
        follow()
    }

    /// Follows the pass if it isn't already, replaying from its start. Only
    /// while attached, so a late load can't open a stream for a hidden tab.
    func follow() {
        guard attached, let id = tab.follow.followId, id != followed else { return }
        followed = id
        stream?.cancel()
        progress = MutationProgress()
        let (client, ws, pr) = (client, workspaceId, prId)
        stream = Task {
            do {
                for try await event in try client.mutationProgress(workspaceId: ws, prId: pr) {
                    guard followed == id else { return }
                    progress = progress.map { reduceMutationProgress($0, event) }
                }
            } catch is CancellationError {
                return
            } catch {
                if Task.isCancelled { return }
                progress?.error = "Lost track of the run: \(error.localizedDescription)"
            }
            if Task.isCancelled { return }
            progress?.streamEnded = true
            load()
        }
    }

    /// The tab went off screen; the stream starts again, from the beginning, when it returns.
    func detach() {
        attached = false
        stream?.cancel()
        stream = nil
        followed = nil
    }

    func stop() {
        detach()
        for task in tasks.values { task.cancel() }
        tasks = [:]
    }

    func start() {
        guard let headSha = state?.headSha, let confirm = confirming else { return }
        starting = true
        actionError = nil
        run("start") { [self] in
            do {
                let started = try await client.startMutationTesting(workspaceId: workspaceId, prId: prId, headSha: headSha,
                                                                    confirmRunTests: confirm)
                confirming = nil
                startedId = started.runId
                load()
            } catch {
                actionError = error.localizedDescription
            }
            starting = false
        }
    }

    func cancel() {
        actionError = nil
        run("cancel") { [self] in
            do {
                try await client.cancelMutationTesting(workspaceId: workspaceId, prId: prId)
            } catch {
                actionError = error.localizedDescription
            }
        }
    }
}

struct ReviewMutationTab: View {
    let context: ReviewTabContext

    private var model: ReviewMutationModel {
        let pr = context.pr
        return context.workspace.tabModels.get(pr.prId) {
            ReviewMutationModel(client: context.client, workspaceId: pr.workspaceId, prId: pr.prId)
        }
    }

    /// A new consent, setup run or head can unblock or stale the pass.
    private var setupKey: String {
        let p = context.pr.pr
        return "\(p.setupConsent ?? ""):\(p.setupStatus ?? ""):\(p.setupHeadSha ?? ""):\(p.headSha ?? "")"
    }

    var body: some View {
        let model = model
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if model.loading {
                    ReviewWaiting("Loading mutation testing…")
                } else {
                    content(model)
                }
            }
            .padding(16)
            .frame(maxWidth: 820, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .onAppear {
            model.loadConfig()
            context.pr.loadChangedFiles()
        }
        .task(id: context.isActive) { context.isActive ? model.attach() : model.detach() }
        .onDisappear { model.detach() }
        .task(id: setupKey) { model.load() }
    }

    @ViewBuilder private func content(_ model: ReviewMutationModel) -> some View {
        let tab = model.tab
        let finished = tab.running ? nil : model.run
        HStack(spacing: 8) {
            Text("Mutation testing").font(.headline)
            if let finished, finished.status != "running" {
                Text("at \(reportSha(finished.headSha))\(finished.costUsd.map { " · \(reportMoney($0))" } ?? "")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if tab.running {
                Button("Cancel") { model.cancel() }
            } else if tab.canStart {
                Button(model.run == nil ? "Run mutation testing" : "Re-run") { model.confirming = false }
                    .disabled(model.state?.headSha == nil)
            }
        }
        if let error = model.loadError { ReviewErrorText(error) }
        if let error = model.actionError { ReviewErrorText(error) }
        if let blocked = model.state?.blocked, model.confirming == nil { blockedNotice(blocked, model) }
        if let confirm = model.confirming { startPanel(model, confirmRunTests: confirm) }

        if tab.runningElsewhere {
            HStack {
                Text("A pass is running in another Yarvis window.").font(.callout)
                Button("Check again") { model.load() }
            }
        } else if tab.lostTrack {
            HStack {
                Text("The pass's progress stopped coming through.").font(.callout)
                Button("Check again") { model.load() }
            }
        }
        if tab.running, let progress = model.progress {
            ReviewMutationProgressView(progress: progress, links: ReviewLinks(context: context))
        } else if let run = finished {
            outcome(run)
            if let summary = run.summary {
                ReviewMutationReport(run: run, summary: summary, links: ReviewLinks(context: context))
            }
        } else if model.state != nil && model.run == nil && model.confirming == nil && model.state?.blocked == nil {
            Text("Mutation testing makes small changes to the code this PR touches and checks the PR's tests notice each one.")
                .font(.callout).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func blockedNotice(_ blocked: MutationTestingState.Blocked, _ model: ReviewMutationModel) -> some View {
        let p = context.pr.pr
        let canReviewSetup = p.checkoutReady && p.setupStatus != "running"
        VStack(alignment: .leading, spacing: 6) {
            Text("Mutation testing can't start: \(blocked.reason).").font(.callout)
            if blocked.needsTestConfirmation == true {
                Button("Run the tests without a setup script…") { model.confirming = true }
            } else if canReviewSetup {
                Button("Review the setup script…") { context.openSetup() }
            }
        }
        .padding(10)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
    }

    private func startPanel(_ model: ReviewMutationModel, confirmRunTests: Bool) -> some View {
        let c = model.config
        return VStack(alignment: .leading, spacing: 8) {
            Text("Claude Code plans up to \(c.maxMutants) small changes to the code this PR touches, then the PR's own tests run against each one. Planning and explaining what survives are budgeted at \(reportMoney(c.planningBudgetUsd + c.explanationBudgetUsd)) and may cost more; the tests run many times, so this can take a while.")
            if confirmRunTests {
                Text("This repo has no setup script, so the tests run on the checkout as it is. Starting is your agreement to run this PR's tests.")
                    .foregroundStyle(.orange)
            }
            if let notes = model.state?.sandboxNotes, !notes.isEmpty {
                Text(notes).foregroundStyle(.secondary)
            }
            HStack {
                Button(model.starting ? "Starting…" : "Start mutation testing") { model.start() }
                    .disabled(model.starting)

                Button("Not now") { model.confirming = nil }
            }
        }
        .font(.callout)
        .padding(10)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
    }

    @ViewBuilder private func outcome(_ run: MutationRun) -> some View {
        let found = run.summary != nil ? " Below is what it found before then." : ""
        switch run.status {
        case "failed": ReviewErrorText("The pass failed: \(run.error ?? "no reason given")" + found)
        case "cancelled": Text("The pass was cancelled." + found).font(.callout).foregroundStyle(.secondary)
        default: EmptyView()
        }
        if !run.isCurrentHead {
            Text("This pass is for an older head; the pull request has moved to \(reportSha(context.pr.pr.headSha)).\(run.summary != nil ? " Re-run it to test the code as it is now." : "")")
                .font(.callout).foregroundStyle(.orange)
        }
    }
}

/// The phases of a pass being followed, with its live results.
private struct ReviewMutationProgressView: View {
    let progress: MutationProgress
    let links: ReviewLinks

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            let current = mutationPhases.firstIndex(of: progress.phase) ?? mutationPhases.count
            ForEach(Array(mutationPhases.enumerated()), id: \.element) { i, phase in
                HStack(spacing: 6) {
                    if i < current {
                        Image(systemName: "checkmark").foregroundStyle(.green)
                    } else if i == current {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "circle").foregroundStyle(.tertiary)
                    }
                    Text((mutationPhaseLabels[phase] ?? phase)
                        + (phase == "mutants" && i <= current ? " · \(progress.mutants.count) of \(progress.total.map(String.init) ?? "?")" : ""))
                        .font(.callout)
                }
            }
            if let activity = progress.activity {
                Text(activity).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
            }
            if let error = progress.error { ReviewErrorText(error) }
            ForEach(progress.baselines.filter { !$0.passed }) { b in
                Text("\(b.argv.joined(separator: " ")) can't be used: \(b.problem ?? "it failed")")
                    .font(.caption).foregroundStyle(.orange)
            }
            ForEach(progress.mutants) { m in
                ReviewMutantRow(mutant: m, links: links)
            }
        }
    }
}

private func outcomeColor(_ outcome: String) -> Color {
    switch outcome {
    case "killed", "timeout": return .green
    case "survived": return .red
    case "uncovered": return .orange
    default: return .secondary
    }
}

private struct ReviewMutantRow: View {
    let mutant: MutantResult
    let links: ReviewLinks

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Chip(text: mutant.outcome, color: outcomeColor(mutant.outcome))
                ReviewPathLink(path: mutant.path, line: mutant.line, canOpen: links.isChanged(mutant.path)) {
                    links.open(mutant.path, line: mutant.line)
                }
                Text(mutant.description).font(.caption).lineLimit(2)
            }
            if mutant.outcome == "survived" { ReviewMutantDiff(mutant: mutant) }
        }
    }
}

private struct ReviewMutantDiff: View {
    let mutant: MutantResult

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(mutant.oldText.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                Text("- " + line).foregroundStyle(.red)
            }
            ForEach(Array(mutant.newText.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                Text("+ " + line).foregroundStyle(.green)
            }
        }
        .font(.caption.monospaced())
        .textSelection(.enabled)
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 4))
    }
}

/// A finished pass: the verdict, the survivors, then the rest folded by outcome.
private struct ReviewMutationReport: View {
    let run: MutationRun
    let summary: MutationSummary
    let links: ReviewLinks

    var body: some View {
        let mutants = run.execution?.mutants ?? []
        let findings = Dictionary((run.findings ?? []).map { ($0.mutantId, $0) }, uniquingKeysWith: { a, _ in a })
        let survived = mutants.filter { $0.outcome == "survived" }
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Chip(mutationVerdictChips[summary.verdict] ?? ReportChip(summary.verdict, .muted))
                Text(mutationVerdictSentences[summary.verdict] ?? "").font(.callout)
            }
            Text(killRateText(summary)).font(.callout)
            ForEach(summary.notes, id: \.self) { Text("• \($0)").font(.caption).foregroundStyle(.secondary) }
            if !survived.isEmpty {
                ReviewSectionTitle("Survived", count: survived.count)
                ForEach(survived) { m in survivor(m, findings[m.id]) }
            }
            group("Caught", mutants.filter { $0.outcome == "killed" || $0.outcome == "timeout" })
            group("No test reaches", mutants.filter { $0.outcome == "uncovered" })
            group("Equivalent (skipped)", mutants.filter { $0.outcome == "equivalent" })
            let errors = mutants.filter { $0.outcome == "error" }
            if !errors.isEmpty {
                ReviewFold(title: "Proved nothing (\(errors.count))") {
                    ForEach(errors) { m in
                        VStack(alignment: .leading, spacing: 2) {
                            ReviewMutantRow(mutant: m, links: links)
                            Text(String(m.evidence.prefix(300))).font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    private func survivor(_ m: MutantResult, _ finding: MutationFinding?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if let finding { Chip(text: finding.severity, color: finding.severity == "high" ? .red : .orange) }
                Text(finding?.title ?? m.description).font(.callout.weight(.medium))
            }
            ReviewPathLink(path: m.path, line: m.line, canOpen: links.isChanged(m.path)) { links.open(m.path, line: m.line) }
            ReviewMutantDiff(mutant: m)
            if let finding, !finding.detail.isEmpty { Text(finding.detail).font(.callout) }
            Text("Should have been caught by: \(m.testFiles.isEmpty ? m.testCommandId ?? "" : m.testFiles.joined(separator: ", "))")
                .font(.caption).foregroundStyle(.secondary)
            if let suggestion = finding?.suggestion, !suggestion.isEmpty {
                Text("Suggested assertion").font(.caption).foregroundStyle(.secondary)
                Text(suggestion).font(.caption.monospaced()).textSelection(.enabled)
            }
            if !m.evidence.isEmpty {
                ReviewFold(title: "Test output") {
                    Text(m.evidence).font(.caption.monospaced()).textSelection(.enabled)
                }
            }
        }
        .textSelection(.enabled)
        .padding(10)
        .background(Color.red.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
    }

    @ViewBuilder private func group(_ title: String, _ list: [MutantResult]) -> some View {
        if !list.isEmpty {
            ReviewFold(title: "\(title) (\(list.count))") {
                ForEach(list) { ReviewMutantRow(mutant: $0, links: links) }
            }
        }
    }
}
