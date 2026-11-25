import Foundation
import Observation
import UserNotifications
import YarvisClient

/// The bell: pending attention items from the sidecar, plus the server's own
/// approvals (git signatures), which answer in the same place.
@MainActor @Observable
final class AttentionModel {
    private unowned let app: AppModel
    private let client: YarvisClient

    private(set) var inbox = AttentionInbox()
    var items: [AttentionItem] { inbox.items }
    var approvals: [Approval] { inbox.approvals }
    var count: Int { inbox.count }
    var error: String?
    /// The item whose answer sheet is open.
    var answering: AttentionItem?

    private var streamTask: Task<Void, Never>?

    init(app: AppModel, client: YarvisClient) {
        self.app = app
        self.client = client
    }

    func start() {
        reloadApprovals()
        streamTask = Task { await runStream() }
    }

    func stop() {
        streamTask?.cancel()
    }

    /// The stream replays nothing, so each connection starts with a fresh list.
    private func runStream() async {
        while !Task.isCancelled {
            await reloadItems()
            do {
                for try await event in try client.attentionStream() {
                    if case .item(let item) = event { apply(item) }
                }
            } catch YarvisError.unauthorized {
                return
            } catch {
                // Dropped, or the sidecar isn't up yet: retry below.
            }
            // The web waits the same 2 seconds before reconnecting.
            try? await Task.sleep(for: .seconds(2))
        }
    }

    func reload() {
        Task { await reloadItems() }
    }

    private func reloadItems() async {
        do {
            for item in inbox.loadItems(try await client.attentionItems()) { announce(item) }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func apply(_ item: AttentionItem) {
        if let news = inbox.apply(item) { announce(news) }
    }

    private func announce(_ item: AttentionItem) {
        Notifier.post(id: item.id, title: item.title, body: item.body ?? "")
    }

    func reloadApprovals() {
        Task {
            do {
                for a in inbox.loadApprovals(try await client.approvals()) {
                    Notifier.post(id: a.id, title: "Approval needed", body: a.summary)
                }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    func answer(_ approval: Approval, approve: Bool) {
        inbox.remove(approvalId: approval.id)
        perform { [client] in try await client.answerApproval(id: approval.id, approve: approve) }
    }

    func dismiss(_ item: AttentionItem) {
        inbox.remove(itemId: item.id)
        perform { [client] in try await client.setAttentionStatus(id: item.id, "dismissed") }
    }

    /// Opens an item: an answer sheet for questions and permission prompts,
    /// otherwise wherever it points, natively or in the web UI.
    func open(_ item: AttentionItem) {
        if item.kind == "question" || item.isHookPermission {
            answering = item
            return
        }
        if item.isHeadsDown, let headsDown = app.headsDown {
            headsDown.openQuestions(from: item)
            app.attentionOpen = false
            return
        }
        inbox.remove(itemId: item.id)
        perform { [client] in try await client.setAttentionStatus(id: item.id, "read") }
        navigate(item.navTarget)
    }

    private func navigate(_ target: JSONValue?) {
        switch target?["type"]?.stringValue {
        case "chat":
            if let id = target?["sessionId"]?.stringValue { app.openChat(sessionId: id) } else { app.section = .chat }
        case "workspace-claude", "workspace":
            guard let ws = target?["workspaceId"]?.stringValue else {
                app.section = .workspaces
                break
            }
            // An item from the workspace's agent opens on the agent's tab.
            let agent = target?["type"]?.stringValue == "workspace-claude"
            app.openWorkspace(id: ws, focusSessionKey: agent ? WorkspaceSummary.agentSessionId(workspaceId: ws) : nil)
        case "review-workspace":
            guard let ws = target?["workspaceId"]?.stringValue else {
                app.section = .review
                break
            }
            let tab = target?["tab"]?.stringValue.flatMap(ReviewTabSpec.Kind.init(rawValue:))
            app.openReview(OpenReviewRequest(workspaceId: ws, prId: target?["prId"]?.stringValue, tab: tab))
        case "terminal":
            let key = target?["sessionKey"]?.stringValue
            if let key, app.openTerminalSession(key) { break }
            // A session no page owns lands on its workspace, which is at least nearby.
            if let ws = target?["workspaceId"]?.stringValue {
                app.openWorkspace(id: ws, focusSessionKey: key)
            } else {
                app.showWebUI()
            }
        case "heads-down":
            app.section = .headsDown
        default:
            app.showWebUI()
        }
        app.attentionOpen = false
    }

    /// Called after a question or prompt is answered elsewhere in the app.
    func markAnswered(_ item: AttentionItem) {
        inbox.remove(itemId: item.id)
        answering = nil
    }

    func perform(_ action: @escaping @Sendable () async throws -> Void) {
        Task {
            do {
                try await app.withFreshCode(action)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// macOS notifications. They need a bundle identifier, so they work from the
/// `Yarvis.app` wrapper and are skipped under `swift run`.
enum Notifier {
    static var available: Bool { Bundle.main.bundleIdentifier != nil }

    static func requestPermission() {
        guard available else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    static func post(id: String, title: String, body: String) {
        guard available else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }
}
