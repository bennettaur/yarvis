import Foundation
import Observation
import YarvisClient

/// The PR bar's state for one PR: its review and merge actions, the
/// workspace on its branch, the conflict hand-off, and moving the checkout
/// to new commits.
@MainActor @Observable
final class ReviewPrBarModel {
    unowned let workspace: ReviewWorkspaceModel
    let prId: String

    enum Prompt: Equatable { case approve, requestChanges }

    /// The open comment prompt, if any.
    var prompt: Prompt?
    var promptBody = ""
    /// A review, merge or ready action is running; the others wait for it.
    private(set) var busy = false
    var actionError: String?
    /// Set by an approval, until the detail reads it back.
    private(set) var justApproved = false

    /// The Yarvis workspace on the PR's branch; nil when there is none.
    private(set) var linkedWorkspace: WorkspaceForPr?
    private(set) var workspaceLookedUp = false
    private(set) var startingWorkspace = false
    var workspaceError: String?

    enum ConflictStep: Equatable {
        case idle, pending
        case needsConfirm(reason: String)
        case done(AgentHandOff)
        case confirmAgain(AgentHandOff)
    }

    private(set) var conflictStep = ConflictStep.idle
    var conflictError: String?
    /// The one recheck while the provider is still working out mergeability.
    var recheckedMergeability = false

    enum RefreshPhase: Equatable {
        case idle
        case refreshing(line: String?)
        /// `target` is the provider head the refresh was started for.
        case done(target: String?)
        case failed(String)
    }

    private(set) var refreshPhase = RefreshPhase.idle
    private var refreshTask: Task<Void, Never>?
    /// What "Mark reviewed here" said, until the next action.
    var markMessage: String?

    init(workspace: ReviewWorkspaceModel, prId: String) {
        self.workspace = workspace
        self.prId = prId
    }

    func stop() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    private var pr: ReviewPrModel? { workspace.prs[prId] }
    private var client: YarvisClient { workspace.client }

    // MARK: Review and merge

    var approved: Bool { justApproved || pr?.detail.value?.viewerReview == .approved }

    /// Runs one provider write, then reads back what it changed.
    private func run(_ write: @escaping (YarvisClient, PrRef, SeenCommits) async throws -> Void,
                     afterReview: Bool, onSuccess: (() -> Void)? = nil) {
        guard let pr, !busy else { return }
        busy = true
        actionError = nil
        let (ref, seen) = (pr.ref, pr.pr.seen)
        Task { [client] in
            defer { busy = false }
            do {
                try await write(client, ref, seen)
                onSuccess?()
                prompt = nil
                promptBody = ""
                if afterReview { pr.invalidateLastReview() }
                pr.loadDetail(force: true)
                pr.loadStack(force: true)
            } catch {
                actionError = error.localizedDescription
            }
        }
    }

    func markReady() {
        run({ client, ref, _ in try await client.applyReviewAction(ref, .publish) }, afterReview: false)
    }

    func submitPrompt() {
        guard let prompt else { return }
        let body = promptBody.trimmingCharacters(in: .whitespacesAndNewlines)
        switch prompt {
        case .approve:
            run({ client, ref, seen in
                try await client.applyReviewAction(ref, .approve, body: body.isEmpty ? nil : body, seen: seen)
            }, afterReview: true, onSuccess: { self.justApproved = true })
        case .requestChanges:
            guard !body.isEmpty else { return }
            run({ client, ref, seen in
                try await client.applyReviewAction(ref, .requestChanges, body: body, seen: seen)
            }, afterReview: true)
        }
    }

    func merge(_ method: MergeMethod) {
        run({ client, ref, _ in try await client.mergePr(ref, method: method) }, afterReview: false)
    }

    func enableAutoMerge(_ method: MergeMethod) {
        run({ client, ref, _ in try await client.enableAutoMerge(ref, method: method) }, afterReview: false)
    }

    func disableAutoMerge() {
        run({ client, ref, _ in try await client.disableAutoMerge(ref) }, afterReview: false)
    }

    /// The detail read back: an approval it shows no longer needs holding.
    func detailChanged() {
        justApproved = false
    }

    // MARK: The PR's workspace

    func lookUpWorkspace() {
        guard !workspaceLookedUp, let ref = pr?.ref else { return }
        Task { [client] in
            let found = try? await client.workspaceForPr(ref)
            linkedWorkspace = found
            workspaceLookedUp = true
        }
    }

    func openOrStartWorkspace() {
        if let linkedWorkspace {
            workspace.page.app.openWorkspace(id: linkedWorkspace.id)
            return
        }
        guard let ref = pr?.ref, !startingWorkspace else { return }
        startingWorkspace = true
        workspaceError = nil
        Task { [client] in
            defer { startingWorkspace = false }
            do {
                let started = try await client.startWorkspaceForPr(ref)
                workspace.page.app.openWorkspace(id: started.workspaceId)
            } catch {
                workspaceError = error.localizedDescription
            }
        }
    }

    // MARK: Conflicts

    func resolveConflicts(confirm: Bool) {
        guard let pr else { return }
        let ref = pr.ref
        conflictStep = .pending
        conflictError = nil
        Task { [client] in
            do {
                let handOff = try await client.resolvePrConflicts(ref, confirm: confirm)
                if handOff.needsConfirm {
                    conflictStep = .needsConfirm(reason: handOff.reason ?? "")
                    return
                }
                conflictStep = .done(handOff)
                pr.loadDetail(force: true)
                if handOff.outcome == "created" { workspace.page.app.openWorkspace(id: handOff.workspaceId) }
            } catch {
                conflictError = error.localizedDescription
                conflictStep = .idle
            }
        }
    }

    func askSendAgain() {
        if case .done(let handOff) = conflictStep { conflictStep = .confirmAgain(handOff) }
    }

    func cancelConflictStep() {
        switch conflictStep {
        case .confirmAgain(let handOff): conflictStep = .done(handOff)
        default: conflictStep = .idle
        }
    }

    // MARK: The checkout

    var refreshing: Bool {
        if case .refreshing = refreshPhase { return true }
        return false
    }

    /// Moves the checkout to the PR's latest head and follows the run's log.
    func refreshCheckout() {
        guard let pr, !refreshing else { return }
        let target = pr.status.value?.headSha
        refreshPhase = .refreshing(line: nil)
        markMessage = nil
        let (ws, id) = (workspace.id, prId)
        refreshTask = Task { [client] in
            do {
                _ = try await client.refreshReviewPr(workspaceId: ws, prId: id)
                var failure: String?
                for try await event in try client.reviewPrProgress(workspaceId: ws, prId: id) {
                    guard !Task.isCancelled else { return }
                    switch event {
                    case .log(let line): refreshPhase = .refreshing(line: line)
                    case .done(_, let status, let error):
                        if error != nil || status == "failed" { failure = error ?? "The update failed." }
                    case .start: break
                    }
                }
                guard !Task.isCancelled else { return }
                await workspace.read()
                if let failure {
                    refreshPhase = .failed(failure)
                } else {
                    refreshPhase = .done(target: target)
                    pr.invalidateLastReview()
                    pr.loadStatus(force: true)
                }
            } catch {
                guard !Task.isCancelled else { return }
                refreshPhase = .failed(error.localizedDescription)
            }
        }
    }

    func dismissRefresh() {
        refreshPhase = .idle
    }

    func markReviewedHere() {
        guard let pr else { return }
        markMessage = nil
        let (ws, id) = (workspace.id, prId)
        Task { [client] in
            do {
                let mark = try await client.markReviewedHere(workspaceId: ws, prId: id)
                markMessage = "Marked reviewed at \(mark.headSha.prefix(7)). “Since last review” starts from here now."
                pr.invalidateLastReview()
            } catch {
                actionError = error.localizedDescription
            }
        }
    }
}
