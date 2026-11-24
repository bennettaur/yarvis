import SwiftUI
import YarvisClient

/// One PR's verification tab state beyond the checklist `ReviewPrModel`
/// holds: CI evidence, the stack above, mutation testing, the run choices and
/// what has been posted. Kept per PR across tab switches.
@MainActor @Observable
final class ReviewVerificationModel: ReviewTabModel {
    private let client: YarvisClient
    let workspaceId: String
    let prId: String
    let ref: PrRef

    private(set) var runConfig: VerificationRunConfig?
    /// Empty means the Settings choice.
    var harness = ""
    var model = ""
    var effort = ""
    /// The sections the reviewer ticked; nil follows the suggestions.
    var picked: [String]?
    /// Nil until typed; the checklist's last tickets show until then.
    var tickets: String?
    private(set) var starting = false
    var startError: String?
    var rowErrors: [String: String] = [:]

    private(set) var evidence: VerificationEvidence?
    private(set) var evidenceLoading = false
    private(set) var evidenceError: String?
    private(set) var upstack: VerificationUpstack?
    private(set) var mutation: MutationTestingState?
    private(set) var mutationError: String?
    /// The Yarvis workspace on this PR's branch, which findings can be added to.
    private(set) var linked: WorkspaceForPr?
    private(set) var posts: [String: ReviewPostState] = [:]

    /// The decision panel's submit in flight.
    private(set) var deciding = false
    private(set) var decisionError: String?
    private(set) var decisionDone: String?
    /// Comments a failed "request changes" already posted, and the head they were posted at.
    private(set) var requestPosted: (head: String, ids: Set<String>) = ("", [])
    private var tasks: [String: Task<Void, Never>] = [:]

    init(client: YarvisClient, workspaceId: String, prId: String, ref: PrRef) {
        self.client = client
        self.workspaceId = workspaceId
        self.prId = prId
        self.ref = ref
    }

    private func run(_ key: String, _ work: @escaping @MainActor () async -> Void) {
        tasks[key]?.cancel()
        tasks[key] = Task { await work() }
    }

    func loadOnce() {
        if runConfig == nil { run("config") { [self] in runConfig = try? await client.verificationRunConfig() } }
        if evidence == nil && !evidenceLoading { loadEvidence() }
        if upstack == nil {
            run("upstack") { [self] in upstack = try? await client.verificationUpstack(workspaceId: workspaceId, prId: prId) }
        }
        if linked == nil { run("linked") { [self] in linked = try? await client.workspaceForPr(ref) } }
        loadMutation()
    }

    func stop() {
        for task in tasks.values { task.cancel() }
        tasks = [:]
        evidenceLoading = false
        starting = false
        deciding = false
    }

    func loadEvidence() {
        evidenceLoading = true
        run("evidence") { [self] in
            do {
                evidence = try await client.verificationEvidence(workspaceId: workspaceId, prId: prId)
                evidenceError = nil
            } catch {
                evidenceError = error.localizedDescription
            }
            evidenceLoading = false
        }
    }

    func loadMutation() {
        run("mutation") { [self] in
            do {
                mutation = try await client.mutationTesting(workspaceId: workspaceId, prId: prId)
                mutationError = nil
            } catch {
                mutationError = error.localizedDescription
            }
        }
    }

    func start(_ sections: [String], checklist: VerificationChecklist?, pr: ReviewPrModel) {
        guard !sections.isEmpty else { return }
        starting = true
        startError = nil
        for s in sections { rowErrors[s] = nil }
        let request = verificationRunRequest(typedTickets: tickets, savedTickets: checklist?.namedTickets ?? [],
                                             model: model, effort: effort, harness: harness)
        run("start") { [self] in
            do {
                let started = try await client.startVerification(
                    workspaceId: workspaceId, prId: prId, sections: sections, namedTickets: request.namedTickets,
                    choice: request.choice, harness: request.harness)
                for f in started.failed { rowErrors[f.section] = f.error }
                picked = pickedAfterStart(picked, started: Set(started.runs.map(\.section)))
            } catch {
                startError = error.localizedDescription
            }
            starting = false
            pr.loadChecklist(force: true)
        }
    }

    func cancel(runId: String, section: String, pr: ReviewPrModel) {
        run("cancel:\(section)") { [self] in
            do {
                try await client.cancelAgentRun(id: runId)
            } catch {
                rowErrors[section] = error.localizedDescription
            }
            pr.loadChecklist(force: true)
        }
    }

    func postToPr(key: String, path: String, line: Int, body: String, _ pr: ReviewPrModel) {
        posts[key] = .posting
        let (client, ref, seen) = (client, ref, pr.pr.seen)
        run("post:\(key)") { [self] in
            do {
                let result = try await client.postPrComment(ref, NewPrComment(path: path, line: line, body: body), seen: seen)
                posts[key] = .postedToPr(onFile: result.placement == .file)
                pr.loadDetail(force: true)
                pr.invalidateLastReview()
            } catch {
                posts[key] = .failed(error.localizedDescription)
            }
        }
    }

    func addToWorkspace(key: String, path: String, line: Int, body: String) {
        guard let linked else { return }
        posts[key] = .posting
        run("add:\(key)") { [self] in
            do {
                _ = try await client.addFindingToWorkspace(workspaceId: linked.id, workspaceRepoId: linked.workspaceRepoId,
                                                           path: path, line: line, body: body)
                posts[key] = .added
            } catch {
                posts[key] = .failed(error.localizedDescription)
            }
        }
    }

    func clearDecisionMessages() {
        decisionError = nil
        decisionDone = nil
    }

    /// The PR's threads, its vote in a stack and the last-review mark change with what was sent.
    private func refreshAfterDecision(_ pr: ReviewPrModel) {
        pr.loadDetail(force: true)
        pr.loadStack(force: true)
        pr.invalidateLastReview()
    }

    func approve(_ body: String, pr: ReviewPrModel, done: @escaping @MainActor () -> Void) {
        guard !deciding else { return }
        deciding = true
        clearDecisionMessages()
        let (seen, text) = (pr.pr.seen, body.trimmingCharacters(in: .whitespacesAndNewlines))
        run("decide") { [self] in
            do {
                try await client.applyReviewAction(ref, .approve, body: text.isEmpty ? nil : text, seen: seen)
                refreshAfterDecision(pr)
                decisionDone = "Approved."
                done()
            } catch {
                decisionError = error.localizedDescription
            }
            deciding = false
        }
    }

    /// Posts the drafts with lines, then the verdict; a retry at the same head skips what went up.
    func requestChanges(_ chosen: [DraftComment], summary: String, pr: ReviewPrModel,
                        done: @escaping @MainActor () -> Void) {
        guard !deciding else { return }
        deciding = true
        clearDecisionMessages()
        let head = pr.pr.headSha ?? ""
        let already = postedIds(head: head)
        let seen = pr.pr.seen
        run("decide") { [self] in
            let outcome = await sendChangesRequest(client: client, ref: ref, chosen: chosen, summary: summary,
                                                            seen: seen, posted: already)
            requestPosted = (head, outcome.posted)
            if let error = outcome.error {
                decisionError = error
            } else {
                decisionDone = "Changes requested."
                done()
            }
            // Whatever went up shows on the PR, even when the rest didn't.
            refreshAfterDecision(pr)
            deciding = false
        }
    }

    /// The drafts already posted at `head`; after a push, nothing posted at the old one counts.
    func postedIds(head: String) -> Set<String> {
        requestPosted.head == head ? requestPosted.ids : []
    }
}

/// The verification checklist: every section of the report, grouped by
/// theme, each run on its own, with the report its newest results make.
struct ReviewVerificationTab: View {
    let context: ReviewTabContext

    private var pr: ReviewPrModel { context.pr }

    private var model: ReviewVerificationModel {
        let pr = context.pr
        return context.workspace.tabModels.get(pr.prId) {
            ReviewVerificationModel(client: context.client, workspaceId: pr.workspaceId, prId: pr.prId, ref: pr.ref)
        }
    }

    var body: some View {
        let model = model
        let checklist = pr.checklist.value
        let anyRunning = checklist?.items.contains { $0.latest?.status == "running" } ?? false
        let mutationRunning = model.mutation?.run?.status == "running"
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let checklist {
                    content(model, checklist)
                } else if let error = pr.checklist.error {
                    ReviewErrorText(error)
                } else {
                    ReviewWaiting("Loading the verification checklist…")
                }
            }
            .padding(16)
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .onAppear {
            pr.loadChecklist()
            pr.loadViewed()
            pr.loadChangedFiles()
            pr.loadTree()
            pr.loadDetail()
            model.loadOnce()
        }
        .reviewPoll(context, while: anyRunning) { pr.loadChecklist(force: true) }
        .reviewPoll(context, while: mutationRunning) { model.loadMutation() }
    }

    @ViewBuilder private func content(_ model: ReviewVerificationModel, _ checklist: VerificationChecklist) -> some View {
        let inputs = decisionInputs(checklist: checklist, evidence: model.evidence, upstack: model.upstack)
        let (evidence, upstack, currentSections) = (inputs.evidence, inputs.upstack, inputs.currentSections)
        let mutationRun = model.mutation?.run
        let assessment = assessReview(report: checklist.report, evidence: evidence, items: checklist.items,
                                      mutation: mutationRun, upstack: upstack)
        let picked = model.picked ?? suggestedSections(checklist.items)
        topBar(model, checklist, picked: picked, assessment: assessment, evidence: evidence)
        if let error = model.startError { ReviewErrorText(error) }
        ReviewDecisionPanel(context: context, model: model, assessment: assessment, report: checklist.report,
                            evidence: evidence, currentSections: currentSections)
        Text("Each check is an agent that reads every changed file's diff. Run the ones you want; each runs on its own, and the report below shows each check's newest result. Beside them is what CI, code scanners and bots already reported on the PR.")
            .font(.caption).foregroundStyle(.secondary)
        evidenceStatus(model, checklist)
        ticketsField(model, checklist)
        if let size = checklist.size {
            FileNoticesView(notices: fileNotices(binary: size.binary, truncated: size.truncated, skimmed: size.skimmed))
        }
        ForEach(checklist.themes, id: \.self) { theme in
            VStack(alignment: .leading, spacing: 4) {
                ReviewSectionTitle(theme.label)
                ForEach(checklist.items.filter { $0.theme == theme.id }, id: \.section) { item in
                    checklistRow(model, checklist, item, picked: picked)
                }
                if theme.id == "correctness" { mutationRow(model) }
                ForEach((evidence ?? []).filter { $0.theme == theme.id }, id: \.id) { item in
                    ReviewEvidenceRow(item: item, ctx: reportContext(model, currentSections, upstack))
                }
            }
        }
        if let report = checklist.report {
            Divider()
            ReviewReportView(report: report, ctx: reportContext(model, currentSections, upstack))
        }
    }

    private func reportContext(_ model: ReviewVerificationModel, _ current: Set<String>,
                               _ upstack: VerificationUpstack?) -> ReviewReportContext {
        ReviewReportContext(context: context, model: model, currentSections: current, upstack: upstack)
    }

    // MARK: Top bar

    private func topBar(_ model: ReviewVerificationModel, _ checklist: VerificationChecklist, picked: [String],
                        assessment: ReviewAssessment, evidence: [EvidenceItem]?) -> some View {
        HStack(spacing: 8) {
            Text("Verification").font(.headline)
            Button {
                copyReport(checklist, assessment: assessment, evidence: evidence, mutation: model.mutation?.run)
            } label: {
                Image(systemName: "doc.on.doc")
            }
            .buttonStyle(.borderless)
            .help("Copy the whole report as Markdown, to paste into Claude")
            Spacer()
            if let config = model.runConfig, config.harnesses.count > 1 {
                Picker("Harness", selection: Bindable(model).harness) {
                    Text(config.harness.flatMap { id in config.harnesses.first { $0.id == id }?.name } ?? "Settings harness").tag("")
                    ForEach(config.harnesses, id: \.id) { Text($0.name).tag($0.id) }
                }
                .labelsHidden()
                .fixedSize()
                .help("Run the checks you start with another Claude Code harness than the one set in Settings")
            }
            Picker("Model", selection: Bindable(model).model) {
                Text("Each check's model").tag("")
                ForEach(["sonnet", "opus", "haiku"], id: \.self) { Text("Claude \($0.capitalized)").tag($0) }
            }
            .labelsHidden()
            .fixedSize()
            .help("Run the checks you start on one model instead of each check's own, set in Settings")
            Picker("Effort", selection: Bindable(model).effort) {
                Text("Each check's effort").tag("")
                ForEach(["low", "medium", "high", "xhigh", "max"], id: \.self) { Text("\($0) effort").tag($0) }
            }
            .labelsHidden()
            .fixedSize()
            .help("Run the checks you start at one effort instead of each check's own, set in Settings")
            Button(model.starting ? "Starting…" : "Run picked (\(picked.count))") {
                model.start(picked, checklist: checklist, pr: pr)
            }
            .disabled(model.starting || !pr.pr.checkoutReady || picked.isEmpty)
            .help(!pr.pr.checkoutReady ? "Waiting for the checkout" : picked.isEmpty ? "Pick at least one check" : "")
        }
    }

    private func copyReport(_ checklist: VerificationChecklist, assessment: ReviewAssessment, evidence: [EvidenceItem]?,
                            mutation: MutationRun?) {
        let p = pr.pr
        let input = ReportExportInput(
            title: pr.detail.value?.title ?? p.title, url: p.ref.webURL?.absoluteString ?? "", author: p.author,
            headRef: p.headRef, baseRef: p.baseRef, headSha: p.headSha, report: checklist.report, items: checklist.items,
            assessment: assessment, evidence: evidence, mutation: mutation)
        copyToPasteboard(verificationReportMarkdown(input))
    }

    @ViewBuilder private func evidenceStatus(_ model: ReviewVerificationModel, _ checklist: VerificationChecklist) -> some View {
        HStack(spacing: 6) {
            if model.evidenceLoading {
                Text("Reading CI checks and scanner results…")
            } else if let error = model.evidenceError {
                Text("Couldn't read CI results: \(error)").foregroundStyle(.red)
            } else if let ev = model.evidence, ev.headSha != checklist.headSha {
                Text("CI results are for \(reportSha(ev.headSha)); the checkout is at \(reportSha(checklist.headSha)).")
                    .foregroundStyle(.orange)
            }
            Button(model.evidenceLoading ? "Re-reading CI results…" : "Re-read CI results") { model.loadEvidence() }
                .buttonStyle(.link)
                .disabled(model.evidenceLoading)
        }
        .font(.caption)
    }

    private func ticketsField(_ model: ReviewVerificationModel, _ checklist: VerificationChecklist) -> some View {
        HStack(spacing: 6) {
            Text("More tickets for the change map and claims").font(.caption)
                .help("Issues the PR closes, its linked work items, and Jira keys in its title or branch are read anyway.")
            TextField("ABC-123, #45 or a ticket link", text: Binding(
                get: { model.tickets ?? checklist.namedTickets.joined(separator: ", ") },
                set: { model.tickets = $0 }))
                .textFieldStyle(.roundedBorder)
                .font(.caption)
        }
    }

    // MARK: Rows

    private func checklistRow(_ model: ReviewVerificationModel, _ checklist: VerificationChecklist, _ item: ChecklistItem,
                              picked: [String]) -> some View {
        let latest = item.latest
        let running = latest?.status == "running"
        let runningHere = running && latest?.live == true
        let isPicked = picked.contains(item.section)
        let rerun = latest.flatMap { $0.id != item.result?.id ? $0 : nil }
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Toggle(isOn: Binding(get: { isPicked }, set: { on in
                    var next = picked.filter { $0 != item.section }
                    if on { next.append(item.section) }
                    model.picked = next
                })) {
                    Text(item.label).help(item.description)
                }
                .disabled(running)
                if runningHere {
                    ProgressView().controlSize(.mini)
                    Text("Running").font(.caption).foregroundStyle(.secondary)
                } else if running {
                    Text("Running in another Yarvis instance").font(.caption).foregroundStyle(.secondary)
                } else {
                    if rerun?.status == "failed" { Chip(text: "Last run failed", color: .red, help: rerun?.error) }
                    if rerun?.status == "cancelled" { Chip(text: "Last run cancelled") }
                    if let report = checklist.report, item.result != nil,
                       let chip = resultVerdict(section: item.section, report: report) {
                        Chip(chip)
                    }
                    if let result = item.result, !result.current {
                        Chip(text: "older head (\(reportSha(result.headSha)))", color: .orange)
                    }
                    if let cost = item.result?.costUsd { Text(reportMoney(cost)).font(.caption).foregroundStyle(.secondary) }
                    if item.result == nil && latest == nil { Text("Not run").font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                if item.section == "flow", item.result != nil {
                    Button("Open") { context.openTab(ReviewTabSpec(kind: .diagram, prId: pr.prId)) }
                }
                if runningHere, let id = latest?.id {
                    Button("Cancel") { model.cancel(runId: id, section: item.section, pr: pr) }
                } else if !running {
                    Button(latest != nil ? "Re-run" : "Run") { model.start([item.section], checklist: checklist, pr: pr) }
                        .disabled(!pr.pr.checkoutReady || model.starting)
                }
            }
            .controlSize(.small)
            if let error = model.rowErrors[item.section] { ReviewErrorText(error) }
        }
    }

    private func mutationRow(_ model: ReviewVerificationModel) -> some View {
        let state = model.mutation
        let run = state?.run
        let chip = run.flatMap { $0.status == "running" ? nil : mutationChip($0) }
        return HStack(spacing: 8) {
            Text("Mutation testing")
                .help("Small deliberate bugs in the changed code, run against the PR's tests, to see whether the tests notice.")
                .padding(.leading, 20)
            if run?.status == "running" {
                ProgressView().controlSize(.mini)
                Text("Running (\(run?.phase ?? ""))").font(.caption).foregroundStyle(.secondary)
            }
            if let chip { Chip(chip) }
            if let run, !run.isCurrentHead { Chip(text: "older head (\(reportSha(run.headSha)))", color: .orange) }
            if run == nil, model.mutationError == nil {
                Text("Not run\(state?.blocked.map { ": \($0.reason)" } ?? "")").font(.caption).foregroundStyle(.secondary)
            }
            if let error = model.mutationError { ReviewErrorText(error) }
            Spacer()
            Button("Open") { context.openTab(ReviewTabSpec(kind: .mutation, prId: pr.prId)) }
        }
        .controlSize(.small)
    }
}

/// What another tool already reported: CI checks, code scanning or bot
/// comments. Their text was written by the tool, so it is plain text.
private struct ReviewEvidenceRow: View {
    let item: EvidenceItem
    let ctx: ReviewReportContext
    @State private var expanded = false

    var body: some View {
        let total = item.entries.count + item.hiddenEntries
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(item.label).help(item.description).padding(.leading, 20)
                Chip(ReportChip(item.summary, ReportTone(rawValue: item.tone) ?? .muted))
                Text("reported on the PR").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if total > 0 {
                    Button(expanded ? "Hide" : "Show \(total)") { expanded.toggle() }.buttonStyle(.link).font(.caption)
                }
            }
            if let note = item.note { Text(note).font(.caption).foregroundStyle(.secondary).padding(.leading, 20) }
            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(item.entries.enumerated()), id: \.offset) { _, e in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(e.severity).font(.caption2).foregroundStyle(severityColor(e.severity))
                                // Check names already lead their titles; a scanner's name doesn't.
                                if !e.title.hasPrefix(e.source) {
                                    Text(e.source).font(.caption).foregroundStyle(.secondary)
                                }
                                Text(e.title).font(.caption.weight(.medium))
                                if let path = e.path {
                                    ReviewPathLink(path: path, line: e.line, canOpen: ctx.canOpen(path)) { ctx.open(path, e.line) }
                                }
                                if e.url != nil {
                                    Button("Open") { openExternal(e.url) }.buttonStyle(.link).font(.caption).help(e.url ?? "")
                                }
                            }
                            if !e.detail.isEmpty { Text(e.detail).font(.caption).foregroundStyle(.secondary) }
                        }
                        .textSelection(.enabled)
                    }
                    if item.hiddenEntries > 0 {
                        Text("\(item.hiddenEntries) more not shown; see the PR.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.leading, 28)
            }
        }
        .controlSize(.small)
    }

    private func severityColor(_ severity: String) -> Color {
        switch severity {
        case "high": return .red
        case "medium": return .orange
        default: return .secondary
        }
    }
}
