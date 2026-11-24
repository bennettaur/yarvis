import SwiftUI
import YarvisClient

/// The "What's changed" summary for one PR: the latest stored run for the
/// range the tab compares, the run being followed, and what started it.
@MainActor @Observable
final class ReviewRereviewModel: ReviewTabModel {
    private let client: YarvisClient
    let workspaceId: String
    let prId: String

    /// The review head the range starts from.
    private(set) var from: String?
    private(set) var latest: LatestRereview?
    private(set) var loadError: String?
    /// The run this tab started and the range it was for, until it finishes.
    private var started: (runId: String, from: String)?
    private(set) var progress: RereviewProgress?
    private(set) var starting = false
    var confirming = false
    var actionError: String?

    /// Ranges already offered a start by themselves, so each starts at most once.
    private var autoStarted = Set<String>()
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

    private var startedId: String? { started?.from == from ? started?.runId : nil }

    var run: RereviewRun? { latest?.run }
    var follow: AgentRunFollow { rereviewFollow(latest, startedId: startedId, progress: progress) }
    var running: Bool { follow.running }
    var runningElsewhere: Bool { follow.runningElsewhere }

    private func run(_ key: String, _ work: @escaping @MainActor () async -> Void) {
        tasks[key]?.cancel()
        tasks[key] = Task { await work() }
    }

    /// Points the model at the range starting at `from`; a new range drops the old one's run.
    func show(from: String) {
        if self.from != from {
            self.from = from
            latest = nil
            closeStream()
        }
        load()
    }

    func load() {
        guard let from else { return }
        generation += 1
        let generation = generation
        run("load") { [self] in
            do {
                let next = try await client.latestRereview(workspaceId: workspaceId, prId: prId, from: from)
                guard generation == self.generation, self.from == from else { return }
                latest = next
                loadError = nil
                if let s = started, next.run?.id == s.runId, next.run?.status != "running" { started = nil }
                followRun()
                autoStartIfDue(from: from)
            } catch {
                guard generation == self.generation, !Task.isCancelled else { return }
                loadError = error.localizedDescription
            }
        }
    }

    /// Only while the tab is showing: a paid run shouldn't start from a tab nobody sees.
    private func autoStartIfDue(from: String) {
        guard attached, let latest, !autoStarted.contains(from),
              shouldAutoStartRereview(latest, autoStart: true, alreadyStarted: startedId != nil) else { return }
        autoStarted.insert(from)
        run("autoStart") { [self] in
            // Without the setting the button still works; nothing starts by itself.
            guard let config = try? await client.rereviewRunConfig(), config.autoStart, self.from == from else { return }
            start()
        }
    }

    func attach() {
        attached = true
        followRun()
        if let from { autoStartIfDue(from: from) }
    }

    /// Follows the run if it isn't already. Only while attached, so a late
    /// load or start can't open a stream for a hidden tab.
    func followRun() {
        guard attached, let id = follow.followId, id != followed else { return }
        followed = id
        stream?.cancel()
        progress = RereviewProgress()
        stream = Task {
            do {
                for try await event in try client.agentRunEvents(id: id) {
                    guard followed == id else { return }
                    progress = progress.map { reduceRereviewProgress($0, event) }
                }
            } catch is CancellationError {
                return
            } catch {
                if Task.isCancelled { return }
                progress?.error = "Lost track of the run: \(error.localizedDescription)"
            }
            if Task.isCancelled { return }
            // A stream that closed without `done` leaves nothing to follow.
            if progress?.finished == nil { progress?.finished = "ended" }
            load()
        }
    }

    private func closeStream() {
        stream?.cancel()
        stream = nil
        followed = nil
        progress = nil
    }

    /// The tab went off screen; the stream replays from the start when it returns.
    func detach() {
        attached = false
        closeStream()
    }

    func stop() {
        detach()
        for task in tasks.values { task.cancel() }
        tasks = [:]
    }

    func start() {
        guard let from else { return }
        confirming = false
        starting = true
        actionError = nil
        run("start") { [self] in
            do {
                let started = try await client.startRereview(workspaceId: workspaceId, prId: prId, from: from)
                self.started = (started.runId, from)
                load()
            } catch {
                actionError = error.localizedDescription
            }
            starting = false
        }
    }

    func cancel() {
        guard let id = follow.followId else { return }
        run("cancel") { [self] in
            do {
                try await client.cancelAgentRun(id: id)
            } catch {
                actionError = error.localizedDescription
            }
        }
    }
}

/// The "What's changed" section of the Since last review tab.
struct ReviewRereviewSummary: View {
    let context: ReviewTabContext
    let since: SinceReview

    private var model: ReviewRereviewModel {
        let pr = context.pr
        return context.workspace.tabModels.get(pr.prId) {
            ReviewRereviewModel(client: context.client, workspaceId: pr.workspaceId, prId: pr.prId)
        }
    }

    var body: some View {
        let model = model
        let good = model.latest?.lastSucceeded
        let review = good?.run.result
        let size = model.latest?.size
        let running = model.running
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("What's changed").font(.headline)
                if let good, review != nil, !running {
                    Text("\(reportSha(good.fromHeadSha))..\(reportSha(good.toHeadSha))\(good.run.costUsd.map { " · \(reportMoney($0))" } ?? "")")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if running {
                    Button("Cancel") { model.cancel() }
                } else if !model.runningElsewhere {
                    Button(model.starting ? "Starting…" : review != nil ? "Re-run" : "What's changed") {
                        if size?.overBudget == true { model.confirming = true } else { model.start() }
                    }
                    .disabled(model.starting || !context.pr.pr.checkoutReady || size?.overAgentBudget == true)
                    .help(context.pr.pr.checkoutReady ? "" : "Waiting for the checkout")
                }
            }
            if review == nil && !running && !model.runningElsewhere {
                Text("An agent checks whether each of your comments was addressed or answered, and sorts the other changes since your review into what needs a look and what is minor.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let size, !running {
                if size.overAgentBudget {
                    Text("Too much changed since your review for one agent to read (about \(Int((Double(size.readBytes) / 1024).rounded())) KB of interdiffs), so the summary won't run. Review the changes in this tab instead.")
                        .font(.caption).foregroundStyle(.orange)
                }
                FileNoticesView(notices: fileNotices(binary: size.binary, noInterdiff: size.noInterdiff, skimmed: size.skimmed))
            }
            if model.confirming, let size, !running {
                VStack(alignment: .leading, spacing: 6) {
                    Text(costLine(estimatedUsd: size.estimatedCostUsd, budgetUsd: size.budgetUsd, overBudget: size.overBudget))
                    HStack {
                        Button("Run anyway") { model.start() }
                        Button("Cancel") { model.confirming = false }
                    }
                }
                .font(.caption)
                .padding(8)
                .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
            }
            if let error = model.actionError { ReviewErrorText(error) }
            if let error = model.loadError { ReviewErrorText(error) }
            if running, let progress = model.progress {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Reading what changed\(progress.steps > 0 ? " · \(progress.steps) steps" : "")").font(.caption)
                    if let activity = progress.activity {
                        Text(activity).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            if model.runningElsewhere {
                HStack {
                    Text("Another Yarvis window is writing this summary.").font(.caption)
                    Button("Check again") { model.load() }.buttonStyle(.link).font(.caption)
                }
            }
            if !running, model.run?.status == "failed", model.latest?.current == true {
                ReviewErrorText("The last run failed: \(model.run?.error ?? model.progress?.error ?? "no reason given")")
            }
            if let good, review != nil, !good.current, !running {
                Text("This summary covers \(reportSha(good.fromHeadSha))..\(reportSha(good.toHeadSha)), not what this tab compares now. Re-run it for the latest changes.")
                    .font(.caption).foregroundStyle(.orange)
            }
            if let review, !running {
                ReviewRereviewView(context: context, review: review, since: since)
            }
        }
        .padding(12)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.25)))
        .task(id: since.fromHeadSha) { model.show(from: since.fromHeadSha) }
        .task(id: context.isActive) { context.isActive ? model.attach() : model.detach() }
        .onDisappear { model.detach() }
    }
}

/// A finished summary: the verdict, the reviewer's comments by what became
/// of them, and the other changes split into what needs reading and what doesn't.
private struct ReviewRereviewView: View {
    let context: ReviewTabContext
    let review: Rereview
    let since: SinceReview

    var body: some View {
        let detail = context.pr.detail.value
        let threads = Dictionary((detail?.reviewThreads ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let conversation = Dictionary((detail?.conversation ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let threadOf = { (c: RereviewComment) in c.kind == "thread" ? threads[c.providerId] : nil }
        let groups = groupRereviewComments(review.comments) { threadOf($0)?.isResolved ?? $0.resolved }
        let ready = rereviewReady(review, groups: groups)
        let needsReview = review.newChanges.filter { $0.kind == "needs_review" }
        let minor = review.newChanges.filter { $0.kind == "minor" }
        let settled = review.settled ?? []
        let item = { (c: RereviewComment) in
            ReviewRereviewComment(context: context, comment: c, thread: threadOf(c),
                                  conversation: c.kind == "conversation" ? conversation[c.providerId] : nil)
        }
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(ready ? "Ready to approve" : "Needs another look").font(.callout.weight(.semibold))
                    .foregroundStyle(ready ? .green : .orange)
                Text(ready && review.verdict != "ready_to_approve"
                    ? "You've resolved the threads that were still open." : review.verdictReason)
                    .font(.caption)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background((ready ? Color.green : Color.orange).opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
            Text(review.summary).font(.callout).textSelection(.enabled)
            if let note = review.serverNote {
                Text("Yarvis checked the answer: \(note) Those are shown as unclear or as needing review.")
                    .font(.caption).foregroundStyle(.orange)
            }

            ReviewSectionTitle("Your comments", count: review.comments.count)
            if review.comments.isEmpty {
                Text(settled.isEmpty ? "You haven't commented on this pull request."
                    : "Your comments were all settled before your review.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !groups.open.isEmpty {
                Text("Still open (\(groups.open.count))").font(.caption).foregroundStyle(.secondary)
                ForEach(groups.open, id: \.threadId) { item($0) }
            }
            if !groups.disagreed.isEmpty {
                Text("Answered with a reason (\(groups.disagreed.count))").font(.caption).foregroundStyle(.secondary)
                ForEach(groups.disagreed, id: \.threadId) { item($0) }
            }
            if !groups.addressed.isEmpty {
                ReviewFold(title: "Addressed or resolved (\(groups.addressed.count))") {
                    ForEach(groups.addressed, id: \.threadId) { item($0) }
                }
            }
            if !settled.isEmpty {
                ReviewFold(title: "Settled before your review (\(settled.count))") {
                    ForEach(settled, id: \.providerId) { s in
                        if let thread = threads[s.providerId] {
                            PrThreadView(context: context, thread: thread)
                        } else {
                            Text(s.path.map { p in s.line.map { "\(p):\($0)" } ?? p } ?? "On the pull request")
                                .font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            ReviewSectionTitle("Other changes", count: review.newChanges.count)
            if review.newChanges.isEmpty {
                Text("Nothing changed beyond the fixes for your comments.").font(.caption).foregroundStyle(.secondary)
            }
            if !needsReview.isEmpty {
                Text("Needs your review (\(needsReview.count))").font(.caption).foregroundStyle(.secondary)
                ForEach(needsReview, id: \.self) { change($0) }
            }
            if !minor.isEmpty {
                ReviewFold(title: "Minor (\(minor.count)) — formatting, comments, renames, small fixes") {
                    ForEach(minor, id: \.self) { change($0) }
                }
            }
        }
    }

    private func change(_ c: RereviewChange) -> some View {
        let sincePaths = Set(since.files.map(\.path))
        let lines = c.lines.map { $0.start == $0.end ? "\($0.start)" : "\($0.start)–\($0.end)" }
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            ReviewPathLink(path: c.path, canOpen: sincePaths.contains(c.path)) {
                context.openTab(.sinceFile(prId: context.pr.prId, path: c.path, from: since.fromHeadSha))
            }
            if let lines { Text("lines \(lines)").font(.caption.monospaced()).foregroundStyle(.secondary) }
            Text(c.reason).font(.caption).textSelection(.enabled)
        }
    }
}

private struct ReviewRereviewComment: View {
    let context: ReviewTabContext
    let comment: RereviewComment
    let thread: PrThread?
    let conversation: PrComment?

    var body: some View {
        let links = ReviewLinks(context: context)
        let evidence = comment.evidence
        // Only where it adds something: another file, or a line other than the comment's.
        let showEvidence = evidence.path != nil
            && (evidence.path != comment.path || (evidence.line != nil && evidence.line != comment.line))
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Chip(text: rereviewVerdictLabels[comment.verdict] ?? comment.verdict, color: verdictColor(comment.verdict))
                if thread?.isResolved == true { Text("resolved").font(.caption2).foregroundStyle(.secondary) }
                if let path = comment.path {
                    ReviewPathLink(path: path, line: comment.line, canOpen: links.isChanged(path)) {
                        context.openTab(.diff(prId: context.pr.prId, path: path, revealLine: comment.line))
                    }
                } else {
                    Text("On the pull request").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let reply = comment.replySummary {
                (Text("The agent's summary of their reply: ").foregroundStyle(.secondary) + Text(reply))
                    .font(.callout).textSelection(.enabled)
            }
            if !evidence.note.isEmpty { Text(evidence.note).font(.callout).textSelection(.enabled) }
            if showEvidence, let path = evidence.path {
                HStack(spacing: 4) {
                    Text("Seen at").font(.caption).foregroundStyle(.secondary)
                    ReviewPathLink(path: path, line: evidence.line, canOpen: links.isChanged(path)) {
                        context.openTab(.diff(prId: context.pr.prId, path: path, revealLine: evidence.line))
                    }
                }
            }
            if let from = comment.downgradedFrom {
                Text("The agent said \"\((rereviewVerdictLabels[from] ?? from).lowercased())\" but \(from == "disagreed" ? "the author didn't reply" : "cited nothing that changed since your review"), so it is shown as unclear.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let thread {
                PrThreadView(context: context, thread: thread)
            } else if let conversation {
                VStack(alignment: .leading, spacing: 2) {
                    Text(conversation.author).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    Text(conversation.body.count > 400 ? String(conversation.body.prefix(399)) + "…" : conversation.body)
                        .font(.caption).textSelection(.enabled)
                }
                .padding(6)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 4))
            }
        }
        .padding(8)
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.2)))
    }

    private func verdictColor(_ verdict: String) -> Color {
        switch verdict {
        case "not_addressed": return .red
        case "partly": return .orange
        case "disagreed": return .blue
        case "addressed": return .green
        default: return .secondary
        }
    }
}
