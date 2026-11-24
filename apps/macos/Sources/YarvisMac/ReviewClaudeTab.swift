import SwiftUI
import YarvisClient

/// The workspace's Ask Claude session: one read-only Claude Code over every
/// checked-out PR, on a PTY the server names after the workspace.
@MainActor @Observable
final class ReviewClaudeModel {
    unowned let workspace: ReviewWorkspaceModel

    enum Phase: Equatable {
        /// No PR is checked out yet.
        case waiting
        case starting
        case live
        case failed(String)
    }

    private(set) var phase = Phase.waiting
    /// Whether the session loads the repos' own skills and CLAUDE.md.
    private(set) var loadRepoConfig = false
    private(set) var controller: TerminalController?
    /// The tab has been shown, so the session should run.
    private var wanted = false
    /// Only the latest start may set the phase.
    private var attempt = 0

    init(workspace: ReviewWorkspaceModel) {
        self.workspace = workspace
    }

    var sessionId: String { YarvisClient.reviewClaudeSessionId(workspaceId: workspace.id) }
    private var client: YarvisClient { workspace.client }
    private var anyCheckoutReady: Bool { workspace.prs.values.contains { $0.pr.checkoutReady } }

    func stop() {
        attempt += 1
        controller?.stop()
        controller = nil
    }

    /// The tab closed: stop following the terminal until it opens again.
    func detach() {
        wanted = false
        stop()
        phase = .waiting
    }

    /// The tab came on screen.
    func appeared() {
        wanted = true
        if phase == .waiting { start(loadRepoConfig: nil) }
    }

    func workspaceChanged() {
        if let saved = workspace.workspace?.askClaudeRepoConfig, phase != .live { loadRepoConfig = saved }
        if wanted && phase == .waiting && anyCheckoutReady { start(loadRepoConfig: nil) }
    }

    func handle(_ event: ServerEvent) {
        guard event.kind == "pty.started", event.data["id"]?.stringValue == sessionId, wanted,
              controller == nil else { return }
        attach()
    }

    private func attach() {
        controller?.stop()
        controller = TerminalController(app: workspace.page.app, client: client, sessionId: sessionId)
        phase = .live
    }

    /// Attaches to a running session, or starts one. `loadRepoConfig` nil
    /// keeps the workspace's saved choice.
    func start(loadRepoConfig choice: Bool?) {
        guard anyCheckoutReady else {
            phase = .waiting
            return
        }
        attempt += 1
        let mine = attempt
        phase = .starting
        let (client, sessionId, id) = (client, sessionId, workspace.id)
        Task {
            if choice == nil, (try? await client.ptyExists(sessionId)) == true {
                guard mine == attempt else { return }
                attach()
                return
            }
            do {
                let started = try await client.startReviewClaudeSession(workspaceId: id, loadRepoConfig: choice)
                guard mine == attempt else { return }
                loadRepoConfig = started
                attach()
            } catch {
                // The start may have landed even though the answer didn't.
                let running = (try? await client.ptyExists(sessionId)) == true
                guard mine == attempt else { return }
                if running { attach() } else { phase = .failed(error.localizedDescription) }
            }
        }
    }

    /// Ends the session and starts a new one over every checked-out PR.
    func restart(loadRepoConfig choice: Bool? = nil) {
        attempt += 1
        let mine = attempt
        controller?.stop()
        controller = nil
        phase = .starting
        if let choice { loadRepoConfig = choice }
        let (client, sessionId) = (client, sessionId)
        Task {
            do {
                // An exited session has nothing to end.
                if try await client.ptyExists(sessionId) {
                    try await workspace.page.app.withFreshCode { [client] in try await client.ptyKill(sessionId) }
                }
            } catch {
                guard mine == attempt else { return }
                phase = .failed(error.localizedDescription)
                return
            }
            guard mine == attempt else { return }
            start(loadRepoConfig: choice ?? loadRepoConfig)
        }
    }
}

struct ReviewClaudeTab: View {
    let context: ReviewTabContext

    private var model: ReviewClaudeModel { context.workspace.claude }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch model.phase {
            case .waiting:
                note("Claude Code starts once the PR is checked out.")
            case .starting:
                note("Starting Claude Code…")
            case .failed(let message):
                VStack(spacing: 8) {
                    Text(message).foregroundStyle(.red).textSelection(.enabled)
                    Button("Retry") { model.start(loadRepoConfig: nil) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .live:
                header
                Divider()
                if let controller = model.controller {
                    TerminalHost(controller: controller)
                } else {
                    note("Starting Claude Code…")
                }
            }
        }
        .onAppear { model.appeared() }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("Read-only: Claude Code reads every PR checked out here but can't edit them, and commands run "
                + "sandboxed and can't reach the network unless you approve it. A PR added later joins on Restart.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Toggle("Repo skills and CLAUDE.md", isOn: Binding(
                get: { model.loadRepoConfig },
                set: { model.restart(loadRepoConfig: $0) }
            ))
            .toggleStyle(.checkbox)
            .font(.caption)
            .help("Loads the checked-out repos' own skills and CLAUDE.md as instructions. Only for PRs whose "
                + "authors you trust. Restarts the session.")
            Button("Restart") { model.restart() }
                .controlSize(.small)
                .help("End this session and start a new one over every checked-out PR")
        }
        .padding(8)
    }

    private func note(_ text: String) -> some View {
        Text(text).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
