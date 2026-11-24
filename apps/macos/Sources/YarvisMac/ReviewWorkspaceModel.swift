import Foundation
import Observation
import YarvisClient

/// One open review workspace: the workspace row, a `ReviewPrModel` per PR,
/// and the tab layout.
@MainActor @Observable
final class ReviewWorkspaceModel {
    unowned let page: ReviewModel
    let client: YarvisClient
    let id: String

    private(set) var workspace: ReviewWorkspace?
    var error: String?
    /// One per PR, by PR id, kept while the PR stays in the workspace.
    private(set) var prs: [String: ReviewPrModel] = [:]

    /// Split or unified, for every diff-like tab. Saved app-wide.
    var diffMode: ReviewDiffMode = ReviewDiffMode(rawValue: UserDefaults.standard.string(forKey: "review.diffMode") ?? "")
        ?? .split {
        didSet { UserDefaults.standard.set(diffMode.rawValue, forKey: "review.diffMode") }
    }

    /// The open tabs, in the order they were opened.
    private(set) var tabs: [ReviewTabSpec] = []
    var activeTabId: String?
    /// A focus asked for before the PR was in the workspace.
    private var pendingFocus: (prId: String, tab: ReviewTabSpec.Kind)?
    /// The PR whose setup prompt is open.
    var setupPrId: String?

    init(page: ReviewModel, client: YarvisClient, id: String) {
        self.page = page
        self.client = client
        self.id = id
        reload()
    }

    func stop() {}

    func handle(_ event: ServerEvent) {}

    func reload() {
        Task {
            do {
                let ws = try await client.reviewWorkspace(id: id)
                apply(ws)
            } catch YarvisError.http(status: 404, _, _) {
                page.closeWorkspace(forget: true)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func apply(_ ws: ReviewWorkspace) {
        workspace = ws
        error = nil
        var next: [String: ReviewPrModel] = [:]
        for row in ws.prs {
            if let model = prs[row.id] {
                model.update(row)
                next[row.id] = model
            } else {
                next[row.id] = ReviewPrModel(client: client, server: client.baseURL, workspaceId: id, pr: row)
            }
        }
        prs = next
        if let focus = pendingFocus, prs[focus.prId] != nil {
            pendingFocus = nil
            openTab(ReviewTabSpec(kind: focus.tab, prId: focus.prId))
        }
    }

    /// The workspace's PRs in nav order.
    var orderedPrs: [ReviewPrModel] {
        prs.values.sorted { $0.pr.position < $1.pr.position }
    }

    /// Opens `tab` on `prId` once the PR is in the workspace.
    func focus(prId: String, tab: ReviewTabSpec.Kind) {
        if prs[prId] != nil {
            openTab(ReviewTabSpec(kind: tab, prId: prId))
        } else {
            pendingFocus = (prId, tab)
            reload()
        }
    }

    /// Opens a tab, or brings it forward if it is open.
    func openTab(_ spec: ReviewTabSpec) {
        if let index = tabs.firstIndex(where: { $0.id == spec.id }) {
            tabs[index] = spec
        } else {
            tabs.append(spec)
        }
        activeTabId = spec.id
    }

    /// Opens the setup prompt for a PR.
    func openSetup(prId: String) {
        setupPrId = prId
    }

    /// Drops what this Mac saved for an archived or missing workspace.
    static func forgetSaved(id: String, server: URL) {
        ServerDefaults(server: server).set(nil, "review.tabs.\(id)")
    }
}

enum ReviewDiffMode: String, Sendable {
    case split, unified
}

/// What a tab body is given: its PR's shared data and the ways out of the tab.
@MainActor
struct ReviewTabContext {
    let workspace: ReviewWorkspaceModel
    let pr: ReviewPrModel
    var diffMode: ReviewDiffMode { workspace.diffMode }
    var client: YarvisClient { workspace.client }
    var app: AppModel { workspace.page.app }

    func openTab(_ spec: ReviewTabSpec) { workspace.openTab(spec) }
    func openSetup() { workspace.openSetup(prId: pr.prId) }
}
