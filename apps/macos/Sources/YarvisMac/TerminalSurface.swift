import AppKit
import Foundation
import Observation
import SwiftTerm
import SwiftUI
import YarvisClient

/// A tab kept at the front of a terminal surface by its owner, such as a
/// workspace's agent session. The owner decides what closing it does.
struct PinnedTerminalTab: Equatable, Identifiable {
    /// Stable within the surface, such as `agent`.
    let key: String
    var title: String
    /// The PTY id, such as `ws-claude:<workspaceId>`.
    let sessionId: String
    var id: String { key }
}

/// A set of terminal tabs with split panes, like the web's `TerminalTabs`.
/// The Terminal page has one (`tab:terminal`), and each workspace has its own
/// (`ws:<workspaceId>`). Pane PTY ids are `<storageKey>/<tabId>/<paneId>`, so
/// attention items can name the exact pane.
///
/// Shortcuts, only while a terminal of this surface has keyboard focus:
/// Cmd+T new tab, Cmd+W close tab, Cmd+D split right, Cmd+Shift+D split
/// below, Cmd+= / Cmd+- / Cmd+0 font size, Shift+Enter a newline for agents.
@MainActor @Observable
final class TerminalSurfaceModel {
    let storageKey: String
    /// The folder new shells start in; nil leaves it to the server.
    let cwd: String?
    let opensShellTab: Bool
    /// Owner-managed tabs shown before the surface's own.
    var pinned: [PinnedTerminalTab] = [] {
        didSet {
            let keys = pinned.map(\.key)
            let previous = oldValue.map(\.key)
            if keys != previous { state.reconcilePinned(keys: keys, previous: previous) }
        }
    }
    /// Called when the user closes a pinned tab.
    var onClosePinned: ((PinnedTerminalTab) -> Void)?
    private(set) var state: TerminalSurfaceState {
        didSet {
            if state != oldValue { UserDefaults.standard.set(state.encoded(), forKey: defaultsKey) }
        }
    }

    private unowned let app: AppModel
    private let client: YarvisClient
    /// One per pane opened, so switching tabs keeps scrollback and the socket.
    @ObservationIgnored private var controllers: [String: TerminalController] = [:]
    @ObservationIgnored private var keyMonitor: Any?
    private var defaultsKey: String { Self.defaultsKey(storageKey) }

    static func defaultsKey(_ storageKey: String) -> String { "yarvis.terminalTabs.\(storageKey)" }

    /// `opensShellTab` starts the surface with one shell tab, and opens a
    /// fresh one when the last is closed, as the Terminal page does; a
    /// workspace's surface starts empty.
    init(app: AppModel, client: YarvisClient, storageKey: String, cwd: String?, opensShellTab: Bool) {
        self.app = app
        self.client = client
        self.storageKey = storageKey
        self.cwd = cwd
        self.opensShellTab = opensShellTab
        state = TerminalSurfaceState.load(UserDefaults.standard.data(forKey: Self.defaultsKey(storageKey)),
                                          opensShellTab: opensShellTab)
        TerminalFont.shared.load(client: client)
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            // AppKit calls local monitors on the main thread.
            nonisolated(unsafe) let key = event
            let handled = MainActor.assumeIsolated { self?.handleKey(key) == true }
            return handled ? nil : event
        }
    }

    func stop() {
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        controllers.values.forEach { $0.stop() }
        controllers = [:]
    }

    // MARK: What's shown

    var activePinned: PinnedTerminalTab? {
        guard let key = state.activePinnedKey else { return nil }
        return pinned.first { $0.key == key }
    }

    /// The selected tab of the surface's own; nil while a pinned tab is.
    var activeTab: TerminalTab? {
        if let tab = state.tab(state.activeTabId) { return tab }
        return activePinned == nil ? state.tabs.first : nil
    }

    func isActive(_ tab: TerminalTab) -> Bool { activePinned == nil && activeTab?.id == tab.id }
    func isActive(_ tab: PinnedTerminalTab) -> Bool { activePinned?.key == tab.key }

    private var attentionKeys: Set<String> {
        Set((app.attention?.items ?? []).filter { $0.status == "pending" }.compactMap(\.sessionKey))
    }

    /// Tabs with a pane that has a pending attention item.
    var flaggedTabIds: Set<String> {
        state.tabIds(withSessionsIn: attentionKeys, surface: storageKey)
    }

    func isFlagged(_ tab: PinnedTerminalTab) -> Bool { attentionKeys.contains(tab.sessionId) }

    func focusedPane(in tabId: String) -> String? { state.focusedPane(in: tabId) }

    func sessionId(tab: String, pane: String) -> String {
        terminalPaneSessionId(surface: storageKey, tab: tab, pane: pane)
    }

    func controller(tab: String, pane: String) -> TerminalController {
        controller(for: sessionId(tab: tab, pane: pane), cwd: cwd)
    }

    /// A pinned session already runs, so its attach never needs a folder.
    func controller(for pinned: PinnedTerminalTab) -> TerminalController {
        controller(for: pinned.sessionId, cwd: nil)
    }

    private func controller(for sessionId: String, cwd: String?) -> TerminalController {
        if let existing = controllers[sessionId] { return existing }
        let controller = TerminalController(app: app, client: client, sessionId: sessionId, cwd: cwd)
        controllers[sessionId] = controller
        return controller
    }

    // MARK: Tabs

    func select(_ tab: TerminalTab) {
        state.activeTabId = tab.id
        focusActivePane()
    }

    func select(_ tab: PinnedTerminalTab) {
        state.activeTabId = TerminalSurfaceState.pinnedTabId(tab.key)
        focusActivePane()
    }

    func newTab() {
        state.openTab()
        focusActivePane()
    }

    func moveTab(_ dragId: String, onto targetId: String) {
        guard let from = state.tabs.firstIndex(where: { $0.id == dragId }),
              let to = state.tabs.firstIndex(where: { $0.id == targetId }) else { return }
        state.moveTab(dragId, nextTo: targetId, after: from < to)
    }

    /// Asks first when a pane runs something, then kills every pane's session.
    func close(_ tab: TerminalTab) {
        let ids = state.sessionIds(of: tab.id, surface: storageKey)
        Task {
            if await anyBusy(ids),
               !confirm("“\(tab.title)” has a running process. Close it and kill the process?") { return }
            await kill(ids)
            removeTab(tab.id)
        }
    }

    func close(_ tab: PinnedTerminalTab) {
        if isActive(tab) {
            state.activeTabId = state.tabs.first?.id ?? ""
        }
        onClosePinned?(tab)
    }

    private func removeTab(_ id: String) {
        guard state.tab(id) != nil else { return }
        state.closeTab(id, opensShellTab: opensShellTab, fallbackPinnedKey: pinned.first?.key)
        focusActivePane()
    }

    // MARK: Panes

    func split(_ direction: SplitDirection) {
        guard let tab = activeTab else { return }
        state.split(tab.id, direction)
        focusActivePane()
    }

    func closePane(_ paneId: String, in tabId: String) {
        let id = sessionId(tab: tabId, pane: paneId)
        Task {
            if await client.ptyIsBusy(id),
               !confirm("This pane has a running process. Close it and kill the process?") { return }
            await kill([id])
            if state.closePane(paneId, in: tabId) {
                focusActivePane()
            } else {
                removeTab(tabId)
            }
        }
    }

    /// Records the pane the user clicked into.
    func focus(pane paneId: String, in tabId: String) {
        state.focus(paneId, in: tabId)
    }

    func setRatio(_ ratio: Double, at path: [PaneStep], in tabId: String) {
        state.setRatio(ratio, at: path, in: tabId)
    }

    /// Brings the tab and pane running `sessionKey` into view. False when no
    /// tab here holds it.
    @discardableResult
    func focus(sessionKey: String) -> Bool {
        if let tab = pinned.first(where: { $0.sessionId == sessionKey }) {
            select(tab)
            return true
        }
        guard let ref = parseTerminalPaneSessionId(sessionKey), ref.surface == storageKey,
              state.tab(ref.tab) != nil else { return false }
        state.activeTabId = ref.tab
        state.focus(ref.pane, in: ref.tab)
        focusActivePane()
        return true
    }

    /// Moves keyboard focus to the selected tab's focused pane, once SwiftUI
    /// has put its view in the window.
    private func focusActivePane() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let pinned = activePinned {
                controllers[pinned.sessionId]?.makeFirstResponder()
            } else if let tab = activeTab, let pane = state.focusedPane(in: tab.id) {
                controllers[sessionId(tab: tab.id, pane: pane)]?.makeFirstResponder()
            }
        }
    }

    // MARK: Sessions

    private func anyBusy(_ ids: [String]) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            for id in ids { group.addTask { [client] in await client.ptyIsBusy(id) } }
            for await busy in group where busy { return true }
            return false
        }
    }

    /// Errors are ignored, as the web does: a session already gone is the
    /// outcome the close wants.
    private func kill(_ ids: [String]) async {
        for id in ids { controllers.removeValue(forKey: id)?.stop() }
        await withTaskGroup(of: Void.self) { group in
            for id in ids { group.addTask { [client] in try? await client.ptyKill(id) } }
        }
    }

    private func confirm(_ message: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "Close")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    // MARK: Keys

    private static let returnKeys: Set<UInt16> = [36, 76]

    /// True when the key was this surface's to handle.
    private func handleKey(_ event: NSEvent) -> Bool {
        guard let responder = event.window?.firstResponder as? TerminalView,
              let controller = controllers.values.first(where: { $0.view === responder }) else { return false }
        let flags = event.modifierFlags.intersection([.shift, .control, .option, .command])
        if flags == .shift, Self.returnKeys.contains(event.keyCode) {
            // What Claude Code reads as a newline rather than submit.
            controller.sendRaw("\u{1b}\r")
            return true
        }
        // Command only: Ctrl+D, T and W belong to the shell.
        guard flags.contains(.command), !flags.contains(.control), !flags.contains(.option) else { return false }
        let shift = flags.contains(.shift)
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "t" where !shift:
            newTab()
        case "w" where !shift:
            if let tab = activeTab, activePinned == nil { close(tab) }
        case "d":
            if activePinned == nil { split(shift ? .horizontal : .vertical) }
        case "=", "+":
            TerminalFont.shared.step(1, app: app, client: client)
        case "-":
            TerminalFont.shared.step(-1, app: app, client: client)
        case "0":
            TerminalFont.shared.step(nil, app: app, client: client)
        default:
            return false
        }
        return true
    }
}

// MARK: - Views

struct TerminalSurfaceView: View {
    @Bindable var model: TerminalSurfaceModel

    var body: some View {
        VStack(spacing: 0) {
            TerminalTabStrip(model: model)
            Divider()
            content
        }
    }

    @ViewBuilder private var content: some View {
        if let pinned = model.activePinned {
            TerminalHost(controller: model.controller(for: pinned)).id(pinned.sessionId)
        } else if let tab = model.activeTab {
            TerminalPaneTree(model: model, tabId: tab.id, pane: tab.root, path: [], inSplit: tab.root.leafIds.count > 1)
                .id(tab.id)
        } else {
            VStack(spacing: 10) {
                Text("No terminal is open.").foregroundStyle(.secondary)
                Button("New terminal") { model.newTab() }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

private struct TerminalTabStrip: View {
    let model: TerminalSurfaceModel

    var body: some View {
        HStack(spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(model.pinned) { tab in
                        TerminalTabChip(title: tab.title, selected: model.isActive(tab), flagged: model.isFlagged(tab),
                                        pinned: true, closable: model.onClosePinned != nil,
                                        onSelect: { model.select(tab) }, onClose: { model.close(tab) })
                    }
                    let flagged = model.flaggedTabIds
                    ForEach(model.state.tabs) { tab in
                        TerminalTabChip(title: tab.title, selected: model.isActive(tab), flagged: flagged.contains(tab.id),
                                        pinned: false, closable: true,
                                        onSelect: { model.select(tab) }, onClose: { model.close(tab) })
                            .draggable(tab.id)
                            .dropDestination(for: String.self) { ids, _ in
                                guard let id = ids.first else { return false }
                                model.moveTab(id, onto: tab.id)
                                return true
                            }
                    }
                }
                .padding(.horizontal, 6)
            }
            Button { model.newTab() } label: { Image(systemName: "plus") }
                .buttonStyle(.borderless)
                .help("New tab (⌘T)")
                .padding(.trailing, 8)
        }
        .padding(.vertical, 4)
    }
}

private struct TerminalTabChip: View {
    let title: String
    let selected: Bool
    let flagged: Bool
    let pinned: Bool
    let closable: Bool
    let onSelect: () -> Void
    let onClose: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 5) {
            if pinned || flagged {
                Circle().fill(flagged ? Color.orange : Color.green).frame(width: 6, height: 6)
            }
            Text(title).lineLimit(1)
                .foregroundStyle(flagged ? AnyShapeStyle(Color.orange) : selected ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            if closable {
                Button(action: onClose) { Image(systemName: "xmark").font(.caption2) }
                    .buttonStyle(.borderless)
                    .opacity(hovering ? 1 : 0)
                    .help("Close")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(selected ? Color.secondary.opacity(0.2) : .clear, in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .onHover { hovering = $0 }
        .help(flagged ? "\(title) — needs you" : title)
    }
}

/// One node of a tab's pane tree. Children are type-erased because the view
/// contains itself.
private struct TerminalPaneTree: View {
    let model: TerminalSurfaceModel
    let tabId: String
    let pane: TerminalPane
    let path: [PaneStep]
    /// True when the tab has more than one pane, so focus is marked.
    let inSplit: Bool

    var body: some View {
        switch pane {
        case .leaf(let paneId):
            TerminalPaneLeaf(model: model, tabId: tabId, paneId: paneId, inSplit: inSplit)
        case .split(let direction, let first, let second, let ratio):
            TerminalSplit(direction: direction, ratio: ratio ?? 0.5,
                          onRatio: { model.setRatio($0, at: path, in: tabId) },
                          first: AnyView(child(first, .first)), second: AnyView(child(second, .second)))
        }
    }

    private func child(_ pane: TerminalPane, _ step: PaneStep) -> TerminalPaneTree {
        TerminalPaneTree(model: model, tabId: tabId, pane: pane, path: path + [step], inSplit: inSplit)
    }
}

private struct TerminalPaneLeaf: View {
    let model: TerminalSurfaceModel
    let tabId: String
    let paneId: String
    let inSplit: Bool
    @State private var hovering = false

    var body: some View {
        let focused = model.focusedPane(in: tabId) == paneId
        TerminalHost(controller: model.controller(tab: tabId, pane: paneId), takesFocus: focused,
                     onClick: { model.focus(pane: paneId, in: tabId) })
            .id(model.sessionId(tab: tabId, pane: paneId))
            .overlay {
                if inSplit {
                    // A wash over the unfocused panes, and a ring on the focused one.
                    if focused {
                        Rectangle().strokeBorder(Color.accentColor.opacity(0.5), lineWidth: 1)
                            .allowsHitTesting(false)
                    } else {
                        Color.black.opacity(0.25).allowsHitTesting(false)
                    }
                }
            }
            .overlay(alignment: .topTrailing) {
                Button { model.closePane(paneId, in: tabId) } label: {
                    Image(systemName: "xmark").font(.caption)
                        .padding(4)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)
                .padding(4)
                .opacity(hovering ? 1 : 0)
                .help("Close pane")
            }
            .onHover { hovering = $0 }
    }
}

/// Two panes and a divider the user can drag.
private struct TerminalSplit: View {
    let direction: SplitDirection
    let ratio: Double
    let onRatio: (Double) -> Void
    let first: AnyView
    let second: AnyView
    /// The ratio while a drag is under way; saved when it ends.
    @State private var dragRatio: Double?
    private static let divider: CGFloat = 1
    private static let grip: CGFloat = 8

    var body: some View {
        GeometryReader { geo in
            let vertical = direction == .vertical
            let total = max((vertical ? geo.size.width : geo.size.height) - Self.divider, 1)
            let shown = dragRatio ?? ratio
            let firstLength = (total * shown).rounded()
            let layout = vertical ? AnyLayout(HStackLayout(spacing: 0)) : AnyLayout(VStackLayout(spacing: 0))
            layout {
                first.frame(width: vertical ? firstLength : nil, height: vertical ? nil : firstLength)
                Rectangle().fill(Color(nsColor: .separatorColor))
                    .frame(width: vertical ? Self.divider : nil, height: vertical ? nil : Self.divider)
                    .overlay {
                        Color.clear
                            .frame(width: vertical ? Self.grip : nil, height: vertical ? nil : Self.grip)
                            .contentShape(Rectangle())
                            .onHover { inside in
                                if inside {
                                    (vertical ? NSCursor.resizeLeftRight : NSCursor.resizeUpDown).push()
                                } else {
                                    NSCursor.pop()
                                }
                            }
                            .gesture(
                                DragGesture(coordinateSpace: .named("split"))
                                    .onChanged { drag in
                                        let at = vertical ? drag.location.x : drag.location.y
                                        dragRatio = min(max(at / total, 0.1), 0.9)
                                    }
                                    .onEnded { _ in
                                        if let dragRatio { onRatio(dragRatio) }
                                        dragRatio = nil
                                    }
                            )
                    }
                second.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .coordinateSpace(name: "split")
        }
    }
}
