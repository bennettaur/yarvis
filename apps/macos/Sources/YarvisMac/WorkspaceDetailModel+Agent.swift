import Foundation
import YarvisClient

/// The workspace's agent session: its liveness, the auto-start on opening a
/// workspace with none running, and starting or ending it from the header.
extension WorkspaceDetailModel {
    var agentSessionId: String { WorkspaceSummary.agentSessionId(workspaceId: id) }

    func loadAgentConfig() async {
        do {
            let config = try await client.agentConfig()
            if !stopped { agentConfig = config }
        } catch {
            if !stopped {
                agentConfigError = "Could not load the configured agent (\(error.localizedDescription)); using the default."
            }
        }
    }

    /// Reads whether the agent runs now, rather than at the next poll.
    func probeAgent() {
        spawn { await self.refreshAgent() }
    }

    /// Reads the agent's liveness, then starts it on a first visit with none
    /// running. The start waits for that first answer, or it would start a
    /// second session over one the sidecar launched (an issue's Start work).
    func refreshAgent() async {
        guard let active = try? await client.ptyExists(agentSessionId), !stopped else { return }
        let changed = active != agent.active || !agent.probed
        agent.probed(active: active)
        if changed {
            let harness = active ? (try? await client.ptySessionHarness(agentSessionId)) ?? nil : nil
            guard !stopped else { return }
            liveHarness = harness
        }
        updatePinned()
        if agent.shouldAutoStart(workspaceStatus: detail?.status ?? "") { startAgent() }
    }

    /// Several harnesses to pick from, and no live agent to name one.
    var showsHarnessPicker: Bool {
        detail?.isActive == true && !agent.active && agentConfig.harnesses.count > 1
    }

    var showsStartButton: Bool { agent.showsStartButton(workspaceStatus: detail?.status ?? "") }

    var startButtonLabel: String {
        let name = agent.active ? (liveHarness?.name ?? agentConfig.name)
            : (chosenHarness(agentConfig, picked: pickedHarness)?.name ?? agentConfig.name)
        return "Start \(name) session"
    }

    /// Starts the agent, or brings back a live one whose tab the user closed.
    func startAgent() {
        guard let summary else { return }
        agent.started()
        agentError = nil
        if agent.active {
            updatePinned()
            select(.terminals)
            return
        }
        let harness = agentConfig.harnesses.count > 1 ? chosenHarness(agentConfig, picked: pickedHarness)?.id : nil
        startingAgent = true
        spawn {
            defer { self.startingAgent = false }
            do {
                try await self.app.withFreshCode { [client = self.client] in
                    try await client.startAgentSession(workspace: summary, harness: harness)
                }
                await self.refreshAgent()
                if !self.stopped { self.select(.terminals) }
            } catch {
                if !self.stopped { self.agentError = error.localizedDescription }
            }
        }
    }

    /// The user closed the agent's tab: end the session, and tell the
    /// sidecar so a restart doesn't resume it.
    func closeAgent() {
        guard !stopped else { return }
        agent.dismiss()
        updatePinned()
        let sessionId = agentSessionId
        spawn {
            do {
                try await self.app.withFreshCode { [client = self.client] in try await client.ptyKill(sessionId) }
                try await self.app.withFreshCode { [client = self.client, id = self.id] in try await client.stopWorkspaceAgent(id: id) }
            } catch {
                if !self.stopped { self.agentError = error.localizedDescription }
            }
            await self.refreshAgent()
        }
    }
}
