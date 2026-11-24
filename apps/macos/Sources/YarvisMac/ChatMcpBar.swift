import AppKit
import Observation
import SwiftUI
import YarvisClient

/// Enabled MCP servers the chat can't use, so the user can fix them before a
/// turn reaches for their tools.
@MainActor @Observable
final class McpConnectionModel {
    private let client: YarvisClient
    private(set) var issues: [McpConnectionIssue] = []
    /// Servers with a sign-in or reconnect running.
    private(set) var working: Set<String> = []
    var error: String?
    private var poll: Task<Void, Never>?

    init(client: YarvisClient) {
        self.client = client
    }

    func recheck() {
        Task { await check() }
    }

    private func check() async {
        // A failed list leaves the bar as it was rather than flashing it empty.
        if let found = try? await client.mcpConnectionIssues() { issues = found }
    }

    /// Rechecks every minute while the bar is on screen.
    func startPolling() {
        poll?.cancel()
        poll = Task {
            while !Task.isCancelled {
                await check()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }

    func stopPolling() {
        poll?.cancel()
        poll = nil
    }

    func fix(_ issue: McpConnectionIssue) {
        let id = issue.server.id
        working.insert(id)
        error = nil
        Task {
            defer { working.remove(id) }
            do {
                switch issue.fix {
                case .authorize:
                    try await authorize(id)
                case .reconnect:
                    let result = try await client.refreshMcpServer(id: id)
                    if result.needsAuthorization == true {
                        try await authorize(id)
                    } else if !result.connected {
                        error = "\(issue.server.name): \(result.error ?? "couldn't connect")"
                    }
                }
            } catch {
                self.error = "\(issue.server.name): \(error.localizedDescription)"
            }
            await check()
        }
    }

    /// Opens the sign-in page in the browser, then waits up to two minutes
    /// for the server to report it done.
    private func authorize(_ id: String) async throws {
        let url = try await client.authorizeMcpServer(id: id)
        openWebLink(url)
        for _ in 0..<60 {
            try await Task.sleep(for: .seconds(2))
            if try await client.mcpServerStatus(id: id).oauth?.authorized == true { return }
        }
    }
}

struct McpConnectionBar: View {
    let model: McpConnectionModel

    var body: some View {
        if !model.issues.isEmpty || model.error != nil {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(model.issues) { issue in
                    HStack(spacing: 8) {
                        Image(systemName: "powerplug").foregroundStyle(.orange)
                        Text(issue.fix == .authorize ? "\(issue.server.name) needs you to sign in."
                            : "\(issue.server.name) isn't connected.")
                            .font(.callout)
                        Spacer()
                        if model.working.contains(issue.id) {
                            ProgressView().controlSize(.small)
                        } else {
                            Button(issue.fix == .authorize ? "Sign in" : "Reconnect") { model.fix(issue) }
                                .controlSize(.small)
                        }
                    }
                }
                if let error = model.error {
                    Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 6)
            .background(.orange.opacity(0.08))
        }
    }
}
