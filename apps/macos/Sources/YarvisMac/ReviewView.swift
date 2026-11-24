import AppKit
import SwiftTerm
import SwiftUI
import YarvisClient

/// The Review page: the workspace list, or the open workspace.
struct ReviewView: View {
    @Bindable var model: ReviewModel

    var body: some View {
        Group {
            if let workspace = model.workspace {
                ReviewWorkspaceView(model: workspace, back: { model.select(nil) })
                    .id(workspace.id)
            } else {
                ReviewListView(model: model)
            }
        }
        .onAppear { model.appeared() }
    }
}

struct ReviewWorkspaceView: View {
    @Bindable var model: ReviewWorkspaceModel
    let back: () -> Void
    @State private var keys: ReviewKeyMonitor?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ReviewWorkspaceHeader(model: model, back: back)
            Divider()
            if let error = model.error ?? model.workspace?.error {
                HStack {
                    Text(error).foregroundStyle(.red).textSelection(.enabled)
                    Spacer()
                    if model.error != nil {
                        Button("Dismiss") { model.error = nil }.buttonStyle(.borderless).controlSize(.small)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.red.opacity(0.08))
            }
            ReviewSplitView(ratio: $model.navRatio, minRatio: ReviewWorkspaceModel.minNavRatio, maxRatio: 0.5) {
                ReviewNavView(model: model)
            } trailing: {
                VStack(spacing: 0) {
                    if let prId = model.frontPrId, let pr = model.prs[prId], let bar = model.bars[prId] {
                        ReviewPrBarView(workspace: model, pr: pr, bar: bar)
                        Divider()
                    }
                    if model.layout.isEmpty {
                        Text("Pick a section or a file on the left.")
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        ReviewTabGroupsView(model: model)
                    }
                }
            }
        }
        .sheet(isPresented: Binding(get: { model.setupPrId != nil }, set: { if !$0 { model.setupPrId = nil } })) {
            if let prId = model.setupPrId, let pr = model.prs[prId] {
                ReviewSetupSheet(workspace: model, pr: pr)
            }
        }
        .onAppear { keys = ReviewKeyMonitor(model: model) }
        .onDisappear {
            keys?.stop()
            keys = nil
        }
    }
}

private struct ReviewWorkspaceHeader: View {
    @Bindable var model: ReviewWorkspaceModel
    let back: () -> Void
    @State private var renaming = false
    @State private var name = ""
    @State private var archiving = false
    @FocusState private var nameFocused: Bool

    var body: some View {
        HStack(spacing: 10) {
            Button(action: back) { Image(systemName: "chevron.left") }
                .help("All review workspaces")
            if renaming {
                TextField("Name", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 260)
                    .focused($nameFocused)
                    .onSubmit(commitRename)
                    .onExitCommand { renaming = false }
                    .onChange(of: nameFocused) { _, focused in if !focused && renaming { commitRename() } }
            } else {
                Button(model.workspace?.name ?? "") {
                    name = model.workspace?.name ?? ""
                    renaming = true
                    nameFocused = true
                }
                .buttonStyle(.plain)
                .font(.headline)
                .help("Rename")
            }
            if let status = model.workspace?.status, status != "active" { WorkspaceStatusChip(status: status) }
            PrLocatorField(model: model.page, actionLabel: "Add PR") { summary in try await model.addPr(summary) }
                .frame(maxWidth: 380)
            Spacer()
            Picker("Diff layout", selection: $model.diffMode) {
                Text("Unified").tag(ReviewDiffMode.unified)
                Text("Split").tag(ReviewDiffMode.split)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .help("Diff layout")
            Button("Side by side") { model.moveActiveToOtherGroup() }
                .help("Move the tab to the other side (⌘\\)")
            Button("Archive") { archiving = true }
                .disabled(model.workspace?.status != "active")
        }
        .padding(8)
        .sheet(isPresented: $archiving) {
            ReviewConfirmSheet(
                title: "Archive “\(model.workspace?.name ?? "")”?",
                message: "Removes the PRs' checkouts from disk and puts the workspace under Show archived. The "
                    + "clones are kept, so reviewing the same repos again starts faster.",
                action: "Archive", busyLabel: "Archiving…"
            ) { try await model.archive() }
        }
    }

    private func commitRename() {
        renaming = false
        model.rename(name)
    }
}

/// Two panes side by side with a divider the user drags. `ratio` is the
/// leading pane's share of the width.
struct ReviewSplitView<Leading: View, Trailing: View>: View {
    @Binding var ratio: Double
    var minRatio = 0.2
    var maxRatio = 0.8
    @ViewBuilder let leading: () -> Leading
    @ViewBuilder let trailing: () -> Trailing
    @State private var dragStart: Double?

    var body: some View {
        GeometryReader { geo in
            let width = max(geo.size.width, 1)
            HStack(spacing: 0) {
                leading().frame(width: width * ratio)
                Rectangle()
                    .fill(Color(nsColor: .separatorColor))
                    .frame(width: 1)
                    .overlay(Color.clear.frame(width: 7).contentShape(Rectangle()))
                    .onHover { inside in if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() } }
                    .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                        .onChanged { drag in
                            let start = dragStart ?? ratio
                            dragStart = start
                            ratio = min(max(start + drag.translation.width / width, minRatio), maxRatio)
                        }
                        .onEnded { _ in dragStart = nil })
                trailing().frame(maxWidth: .infinity)
            }
        }
    }
}

/// The workspace's keyboard shortcuts, live only while the Review page shows
/// this workspace in the key window. Watching keys before the menus see them
/// is what lets Cmd-W close a review tab rather than the window.
@MainActor
final class ReviewKeyMonitor {
    private weak var model: ReviewWorkspaceModel?
    private var monitor: Any?

    init(model: ReviewWorkspaceModel) {
        self.model = model
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            // AppKit calls local monitors on the main thread.
            nonisolated(unsafe) let key = event
            let handled = MainActor.assumeIsolated { self?.handle(key) == true }
            return handled ? nil : event
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    private func handle(_ event: NSEvent) -> Bool {
        guard let model, !model.stopped, model.page.app.section == .review, model.page.workspace === model,
              let window = event.window, window.isKeyWindow, window.attachedSheet == nil,
              window === (NSApp.mainWindow ?? window) else { return false }
        let flags = event.modifierFlags
        let key: ReviewShortcut.Press.Key
        switch event.keyCode {
        case 48: key = .tab
        case 123: key = .left
        case 124: key = .right
        default: key = .character(event.charactersIgnoringModifiers?.lowercased() ?? "")
        }
        let press = ReviewShortcut.Press(key, command: flags.contains(.command), control: flags.contains(.control),
                                         option: flags.contains(.option), shift: flags.contains(.shift))
        guard let shortcut = ReviewShortcut.resolve(press) else { return false }
        if shortcut.yieldsToTextEntry && Self.isTextEntry(window.firstResponder) { return false }
        switch shortcut {
        case .nextTab: model.cycleTab(forward: true)
        case .prevTab: model.cycleTab(forward: false)
        case .closeTab:
            guard let active = model.layout.activeTab else { return false }
            model.closeTab(active.id)
        case .otherGroup: model.moveActiveToOtherGroup()
        case .nextFile: model.stepFile(forward: true)
        case .prevFile: model.stepFile(forward: false)
        }
        return true
    }

    /// Typing into a field, or into the Ask Claude terminal.
    private static func isTextEntry(_ responder: NSResponder?) -> Bool {
        if let text = responder as? NSTextView { return text.isEditable }
        return responder is TerminalView
    }
}
