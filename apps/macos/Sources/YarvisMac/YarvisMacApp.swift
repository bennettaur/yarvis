import AppKit
import SwiftUI
import YarvisClient

@main
struct YarvisMacApp: App {
    @State private var app = AppModel()

    init() {
        // Run from `swift run` there is no bundle telling macOS this is a
        // regular app, so it would open with no Dock icon or focus.
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
        Notifier.requestPermission()
    }

    var body: some Scene {
        WindowGroup("Yarvis") {
            RootView()
                .environment(app)
                .frame(minWidth: 820, minHeight: 520)
                .task { app.restore() }
        }
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Open in Browser") { app.openInBrowser() }
                    .disabled(app.server == nil)
                Button("Show Web UI") { app.showWebUI() }
                    .keyboardShortcut("u", modifiers: [.command, .shift])
                    .disabled(app.server == nil)
                Divider()
                Button("Sign Out") { app.signOut() }
                    .disabled(app.server == nil)
            }
        }

        Window("Yarvis Web", id: "web") {
            if let server = app.server {
                WebUIView(url: server)
                    .frame(minWidth: 900, minHeight: 600)
            } else {
                Text("Sign in first.").padding()
            }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            if app.client == nil {
                SignInView()
            } else {
                MainView()
            }
        }
        .onChange(of: app.webUIRequests) { openWindow(id: "web") }
        .sheet(isPresented: Binding(get: { app.codeRequest != nil }, set: { if !$0 { app.answerCode(nil) } })) {
            CodePromptView()
        }
    }
}

struct MainView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        NavigationSplitView {
            List(Section.allCases, id: \.self, selection: Binding($app.section)) { section in
                Label(section.title, systemImage: section.symbol)
                    .badge(section == .attention ? (app.attention?.count ?? 0) : 0)
            }
            .navigationSplitViewColumnWidth(min: 160, ideal: 180)
            .safeAreaInset(edge: .bottom) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(app.device?.name ?? "").font(.caption)
                    Text(app.server?.host ?? "").font(.caption2).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
            }
        } detail: {
            switch app.section {
            case .chat: if let chat = app.chat { ChatView(chat: chat) }
            case .attention: if let attention = app.attention { AttentionView(model: attention) }
            case .terminals: if let terminals = app.terminals { TerminalsView(model: terminals) }
            }
        }
        .toolbar {
            ToolbarItem {
                Button { app.showWebUI() } label: { Label("Web UI", systemImage: "globe") }
                    .help("Open the full web UI for screens this app doesn't have")
            }
        }
    }
}

/// The authenticator-code prompt for an action that needs a fresh check.
struct CodePromptView: View {
    @Environment(AppModel.self) private var app
    @State private var code = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Confirm it's you").font(.headline)
            Text("Enter the code from your authenticator app.").foregroundStyle(.secondary)
            if let refusal = app.codeRefusal {
                Text(refusal).foregroundStyle(.red)
            }
            TextField("123456", text: $code)
                .textFieldStyle(.roundedBorder)
                .onSubmit(submit)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { app.answerCode(nil) }
                Button("Confirm", action: submit)
                    .keyboardShortcut(.defaultAction)
                    .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 320)
    }

    private func submit() {
        let trimmed = code.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        app.answerCode(trimmed)
    }
}
