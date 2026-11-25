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
                Button("Sign Out") { Task { await app.signOut() } }
                    .disabled(app.server == nil || app.signingOut)
            }
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") { app.openSettings() }
                    .keyboardShortcut(",", modifiers: .command)
                    .disabled(app.client == nil)
            }
            // The web UI's page shortcuts: Cmd-1… for the pages in nav order,
            // and Cmd-Shift-] / Cmd-Shift-[ to cycle through all of them.
            CommandMenu("Go") {
                ForEach(Array(Section.top.enumerated()), id: \.element) { index, page in
                    Button(page.title) { app.section = page }
                        .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                }
                Divider()
                Button("Next Page") { app.cycleSection(by: 1) }
                    .keyboardShortcut("]", modifiers: [.command, .shift])
                Button("Previous Page") { app.cycleSection(by: -1) }
                    .keyboardShortcut("[", modifiers: [.command, .shift])
                Divider()
                Button("Attention") { app.attentionOpen.toggle() }
                    .keyboardShortcut("a", modifiers: [.command, .shift])
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
            } else if let settings = app.settings, settings.vaultNeedsUnlock {
                VaultUnlockView(model: settings)
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
            List(selection: Binding($app.section)) {
                ForEach(Section.top, id: \.self) { page in
                    Label(page.title, systemImage: page.symbol)
                }
            }
            .navigationSplitViewColumnWidth(min: 160, ideal: 180)
            .safeAreaInset(edge: .bottom) { sidebarFooter }
        } detail: {
            page
                .navigationTitle(app.section.title)
                .inspector(isPresented: $app.attentionOpen) {
                    if let attention = app.attention {
                        AttentionView(model: attention)
                            .inspectorColumnWidth(min: 300, ideal: 380, max: 520)
                    }
                }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { app.showWebUI() } label: { Label("Web UI", systemImage: "globe") }
                    .help("Open the full web UI for pages this app doesn't have")
                AttentionBell()
            }
        }
    }

    @ViewBuilder private var page: some View {
        switch app.section {
        case .chat: if let chat = app.chat { ChatView(chat: chat) }
        case .terminal: if let terminals = app.terminals { TerminalsView(model: terminals) }
        case .workspaces: if let workspaces = app.workspaces { WorkspacesView(model: workspaces) }
        case .settings: if let settings = app.settings { SettingsView(model: settings) }
        }
    }

    /// Settings sits at the bottom of the sidebar, as in the web UI's rail,
    /// under who and where this device is signed in.
    private var sidebarFooter: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { app.openSettings() } label: {
                Label(Section.settings.title, systemImage: Section.settings.symbol)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.vertical, 4)
            .padding(.horizontal, 6)
            .background(app.section == .settings ? Color.accentColor.opacity(0.2) : .clear,
                        in: RoundedRectangle(cornerRadius: 5))
            VStack(alignment: .leading, spacing: 2) {
                Text(app.device?.name ?? "").font(.caption)
                Text(app.server?.host ?? "").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
    }
}

/// The toolbar bell: how many things are waiting, and the panel that lists them.
struct AttentionBell: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let count = app.attention?.count ?? 0
        Button { app.attentionOpen.toggle() } label: {
            Label("Attention", systemImage: count > 0 ? "bell.badge.fill" : "bell")
                .foregroundStyle(count > 0 ? .orange : .primary)
                .overlay(alignment: .topTrailing) {
                    if count > 0 {
                        Text("\(count)")
                            .font(.system(size: 9, weight: .bold))
                            .padding(.horizontal, 4)
                            .background(.orange, in: Capsule())
                            .foregroundStyle(.white)
                            .offset(x: 8, y: -6)
                    }
                }
        }
        .help(count > 0 ? "\(count) waiting for you" : "Nothing is waiting")
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
