import AppKit
import SwiftUI
import YarvisClient

/// One or two groups of tabs side by side. Every open tab stays alive while
/// hidden, so a diff keeps its scroll and a terminal its session.
struct ReviewTabGroupsView: View {
    @Bindable var model: ReviewWorkspaceModel

    var body: some View {
        let groups = model.layout.groups
        if groups.count > 1 {
            ReviewSplitView(ratio: Binding(get: { model.layout.ratio }, set: { model.setGroupRatio($0) }),
                            minRatio: ReviewTabLayout.minRatio, maxRatio: 1 - ReviewTabLayout.minRatio,
                            onDragEnd: model.endGroupRatioDrag) {
                ReviewTabGroupView(model: model, index: 0).id(groups[0].key)
            } trailing: {
                ReviewTabGroupView(model: model, index: 1).id(groups[1].key)
            }
        } else {
            ReviewTabGroupView(model: model, index: 0).id(groups.first?.key ?? "a")
        }
    }
}

/// What a dragged tab carries, prefixed so a dragged string from elsewhere isn't taken for a tab.
private let tabDragPrefix = "yarvis-review-tab:"

private func draggedTabId(_ items: [String]) -> String? {
    items.first.flatMap { $0.hasPrefix(tabDragPrefix) ? String($0.dropFirst(tabDragPrefix.count)) : nil }
}

private struct ReviewTabGroupView: View {
    @Bindable var model: ReviewWorkspaceModel
    let index: Int
    @State private var splitHint = false

    var body: some View {
        if model.layout.groups.indices.contains(index) {
            let group = model.layout.groups[index]
            let focused = model.layout.focusedGroup == index && model.layout.groups.count > 1
            VStack(spacing: 0) {
                strip(group, focused: focused)
                Divider()
                GeometryReader { geo in
                    ZStack {
                        ForEach(group.tabs) { spec in
                            if let pr = model.prs[spec.prId] {
                                let active = spec.id == group.activeId
                                ReviewTabHost(active: active, content: ReviewTabBody(
                                    spec: spec, context: ReviewTabContext(workspace: model, pr: pr, isActive: active)))
                                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                            }
                        }
                        if splitHint {
                            HStack(spacing: 0) {
                                Color.clear
                                Color.accentColor.opacity(0.15)
                            }
                            .allowsHitTesting(false)
                        }
                    }
                    .dropDestination(for: String.self) { items, location in
                        splitHint = false
                        guard let id = draggedTabId(items) else { return false }
                        let lone = model.layout.groups.count == 1
                        if lone && location.x > geo.size.width / 2 {
                            model.moveTab(id, toGroup: 1)
                        } else if !lone {
                            model.moveTab(id, toGroup: index)
                        }
                        return true
                    } isTargeted: { over in
                        splitHint = over && model.layout.groups.count == 1
                    }
                }
            }
            .simultaneousGesture(TapGesture().onEnded { model.focusGroup(index) })
        }
    }

    private func strip(_ group: ReviewTabGroup, focused: Bool) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 1) {
                ForEach(group.tabs) { spec in
                    ReviewTabChip(model: model, group: index, spec: spec, active: spec.id == group.activeId)
                }
            }
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: 30)
        .background(Color(nsColor: .windowBackgroundColor))
        .overlay(alignment: .bottom) {
            Rectangle().fill(focused ? Color.accentColor : .clear).frame(height: 2)
        }
        .dropDestination(for: String.self) { items, _ in
            guard let id = draggedTabId(items) else { return false }
            model.moveTab(id, toGroup: index)
            return true
        }
    }
}

private struct ReviewTabChip: View {
    @Bindable var model: ReviewWorkspaceModel
    let group: Int
    let spec: ReviewTabSpec
    let active: Bool
    @State private var width: CGFloat = 1
    @State private var hovering = false

    private var glyph: String? {
        switch spec.kind {
        case .diff: return "±"
        case .sinceFile: return "Δ"
        case .commit: return "●"
        default: return nil
        }
    }

    var body: some View {
        let owner = model.ownerLabel(spec.prId)
        let color = model.prs[spec.prId].map { reviewPrColor($0.pr.colorIndex) } ?? .secondary
        HStack(spacing: 4) {
            if let owner {
                Circle().fill(color).frame(width: 6, height: 6)
                Text(owner).font(.caption2.monospaced()).foregroundStyle(.secondary)
            }
            if let glyph { Text(glyph).font(.caption).foregroundStyle(.secondary) }
            Text(spec.title).font(.caption).lineLimit(1)
            Button { model.closeTab(spec.id) } label: {
                Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
            }
            .buttonStyle(.borderless)
            .opacity(active || hovering ? 1 : 0.3)
            .help("Close tab (⌘W)")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(active ? Color.accentColor.opacity(0.18) : (hovering ? Color.secondary.opacity(0.1) : .clear),
                    in: RoundedRectangle(cornerRadius: 5))
        .background(GeometryReader { geo in Color.clear.onAppear { width = geo.size.width } })
        .contentShape(Rectangle())
        .onTapGesture { model.focusTab(spec.id) }
        .overlay(MiddleClickCatcher { model.closeTab(spec.id) })
        .onHover { hovering = $0 }
        .help(owner.map { "\($0) · \(spec.tooltip)" } ?? spec.tooltip)
        .draggable(tabDragPrefix + spec.id)
        .dropDestination(for: String.self) { items, location in
            guard let id = draggedTabId(items), id != spec.id else { return false }
            let after = location.x > width / 2
            if model.layout.find(id)?.group == group {
                model.reorderTab(id, inGroup: group, onto: spec.id, after: after)
            } else {
                let tabs = model.layout.groups[group].tabs
                let at = tabs.firstIndex { $0.id == spec.id } ?? tabs.count
                let before = after ? (at + 1 < tabs.count ? tabs[at + 1].id : nil) : spec.id
                model.moveTab(id, toGroup: group, before: before)
            }
            return true
        }
    }
}

/// Hosts one tab's body in its own AppKit view, so a hidden tab is really
/// hidden: it draws nothing, takes no clicks, and gives up the key focus
/// if it held it, so typing can't land in a tab nobody sees.
private struct ReviewTabHost: NSViewRepresentable {
    let active: Bool
    let content: ReviewTabBody

    func makeNSView(context: Context) -> NSHostingView<ReviewTabBody> {
        let view = NSHostingView(rootView: content)
        // The group decides the size; a hidden tab's content mustn't widen it or pin the divider.
        view.sizingOptions = []
        view.isHidden = !active
        return view
    }

    func updateNSView(_ view: NSHostingView<ReviewTabBody>, context: Context) {
        view.rootView = content
        guard view.isHidden == active else { return }
        if !active, let window = view.window, let focused = window.firstResponder as? NSView,
           focused.isDescendant(of: view) {
            window.makeFirstResponder(nil)
        }
        view.isHidden = !active
    }
}

/// Closes a tab on a middle click and lets every other click through.
private struct MiddleClickCatcher: NSViewRepresentable {
    let action: () -> Void

    func makeNSView(context: Context) -> CatcherView {
        let view = CatcherView()
        view.action = action
        return view
    }

    func updateNSView(_ view: CatcherView, context: Context) {
        view.action = action
    }

    final class CatcherView: NSView {
        var action: (() -> Void)?

        override func hitTest(_ point: NSPoint) -> NSView? {
            NSApp.currentEvent?.type == .otherMouseDown || NSApp.currentEvent?.type == .otherMouseUp
                ? super.hitTest(point) : nil
        }

        override func otherMouseUp(with event: NSEvent) {
            if event.buttonNumber == 2 { action?() }
        }

        override func otherMouseDown(with event: NSEvent) {}
    }
}
