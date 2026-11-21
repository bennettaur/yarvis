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

    var items: [AttentionItem] = []
    var approvals: [Approval] = []
    var error: String?
    /// The item whose answer sheet is open.
    var answering: AttentionItem?

    var count: Int { items.count + approvals.count }

    private var streamTask: Task<Void, Never>?
    /// Ids already announced, so a re-prompt that updates a row doesn't notify twice.
    private var announced = Set<String>()
    private var loadedOnce = false

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
            let pending = try await client.attentionItems()
            items = pending
            if loadedOnce {
                pending.forEach(announce)
            } else {
                // Items already waiting at launch aren't news.
                announced.formUnion(pending.map(\.id))
                loadedOnce = true
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func apply(_ item: AttentionItem) {
        items.removeAll { $0.id == item.id }
        guard item.status == "pending" else { return }
        items.insert(item, at: 0)
        items.sort { $0.seq > $1.seq }
        announce(item)
    }

    private func announce(_ item: AttentionItem) {
        guard announced.insert(item.id).inserted else { return }
        Notifier.post(id: item.id, title: item.title, body: item.body ?? "")
    }

    func reloadApprovals() {
        Task {
            do {
                let fresh = try await client.approvals()
                for a in fresh where announced.insert(a.id).inserted {
                    Notifier.post(id: a.id, title: "Approval needed", body: a.summary)
                }
                approvals = fresh
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    func answer(_ approval: Approval, approve: Bool) {
        approvals.removeAll { $0.id == approval.id }
        act { [client] in try await client.answerApproval(id: approval.id, approve: approve) }
    }

    func dismiss(_ item: AttentionItem) {
        items.removeAll { $0.id == item.id }
        act { [client] in try await client.setAttentionStatus(id: item.id, "dismissed") }
    }

    /// Opens an item: an answer sheet for questions and permission prompts,
    /// otherwise wherever it points, natively or in the web UI.
    func open(_ item: AttentionItem) {
        if item.kind == "question" || item.isHookPermission {
            answering = item
            return
        }
        if item.isHeadsDown {
            app.showWebUI()
            return
        }
        items.removeAll { $0.id == item.id }
        act { [client] in try await client.setAttentionStatus(id: item.id, "read") }
        navigate(item.navTarget)
    }

    private func navigate(_ target: JSONValue?) {
        switch target?["type"]?.stringValue {
        case "chat":
            app.section = .chat
            if let id = target?["sessionId"]?.stringValue { app.chat?.open(id) }
        case "workspace-claude":
            if let ws = target?["workspaceId"]?.stringValue {
                app.section = .terminals
                app.terminals?.select("ws-claude:\(ws)")
            }
        case "terminal":
            if let key = target?["sessionKey"]?.stringValue {
                app.section = .terminals
                app.terminals?.select(key)
            }
        default:
            app.showWebUI()
        }
    }

    /// Called after a question or prompt is answered elsewhere in the app.
    func finished(_ item: AttentionItem) {
        items.removeAll { $0.id == item.id }
        answering = nil
    }

    func act(_ action: @escaping @Sendable () async throws -> Void) {
        Task {
            do {
                try await app.fresh(action)
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
