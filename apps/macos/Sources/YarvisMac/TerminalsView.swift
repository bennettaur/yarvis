import SwiftTerm
import SwiftUI
import YarvisClient

struct TerminalsView: View {
    @Bindable var model: TerminalsModel

    var body: some View {
        HSplitView {
            sessionList.frame(minWidth: 200, idealWidth: 240, maxWidth: 320)
            detail.frame(minWidth: 420)
        }
    }

    private var sessionList: some View {
        List(selection: Binding(get: { model.selectedId }, set: { if let id = $0 { model.select(id) } })) {
            SwiftUI.Section("Workspace agents") {
                ForEach(model.workspaces) { ws in
                    HStack {
                        Circle().fill(model.session(ws.agentSessionId)?.running == true ? .green : .secondary)
                            .frame(width: 7, height: 7)
                        Text(ws.name).lineLimit(1)
                        Spacer()
                        attachedCount(model.session(ws.agentSessionId))
                    }
                    .tag(ws.agentSessionId)
                }
            }
            SwiftUI.Section("Terminals") {
                ForEach(model.shells) { s in
                    HStack {
                        Text(model.title(s)).lineLimit(1).foregroundStyle(s.running ? .primary : .secondary)
                        Spacer()
                        attachedCount(s)
                    }
                    .tag(s.id)
                    .contextMenu { Button("End the shell") { model.kill(s.id) } }
                }
                ForEach(model.pending, id: \.self) { id in
                    Text("New terminal").foregroundStyle(.secondary).tag(id)
                        .contextMenu { Button("End the shell") { model.kill(id) } }
                }
                Button { model.newTerminal() } label: { Label("New terminal", systemImage: "plus") }
                    .buttonStyle(.borderless)
            }
            if !model.reviews.isEmpty {
                SwiftUI.Section("Review sessions") {
                    ForEach(model.reviews) { s in
                        Text(model.title(s)).lineLimit(1).tag(s.id)
                    }
                }
            }
            if let error = model.error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
        .toolbar {
            ToolbarItem {
                Button { model.reload() } label: { Label("Refresh", systemImage: "arrow.clockwise") }
            }
        }
    }

    /// How many clients are attached, this one included.
    @ViewBuilder private func attachedCount(_ s: PtySession?) -> some View {
        if let s, s.attached > 0 {
            Label("\(s.attached)", systemImage: "person.2").labelStyle(.titleAndIcon)
                .font(.caption2).foregroundStyle(.secondary)
                .help("\(s.attached) attached")
        }
    }

    @ViewBuilder private var detail: some View {
        if let id = model.selectedId {
            if model.canAttach(id) {
                TerminalHost(controller: model.controller(for: id))
                    .id(id)
            } else if let ws = model.workspaces.first(where: { $0.agentSessionId == id }) {
                VStack(spacing: 10) {
                    Text("No agent session is running in \(ws.name).")
                    Button("Start agent") { model.startAgent(ws) }.buttonStyle(.borderedProminent)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            Text("Pick a session, or open a new terminal.")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// Hosts a controller's long-lived `TerminalView`.
struct TerminalHost: NSViewRepresentable {
    let controller: TerminalController

    func makeNSView(context: Context) -> NSView {
        let container = FocusReportingView()
        container.onFocus = { [controller] in controller.focused() }
        let view = controller.view
        view.removeFromSuperview()
        view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            view.topAnchor.constraint(equalTo: container.topAnchor),
            view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return container
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// Reports a click into the terminal, which takes over the PTY size.
final class FocusReportingView: NSView {
    var onFocus: (() -> Void)?

    override func hitTest(_ point: NSPoint) -> NSView? {
        if let event = NSApp.currentEvent, event.type == .leftMouseDown { onFocus?() }
        return super.hitTest(point)
    }
}
