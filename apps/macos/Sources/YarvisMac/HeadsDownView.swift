import SwiftUI
import YarvisClient

/// How many passes the Overview shows before pointing at History.
private let recentPasses = 3

/// The Heads down page: the run and what needs the user above four tabs.
/// Overview has what it is working on and a place to tell it things,
/// Routines the routines passes take on, History every pass, and Settings
/// the heads-down settings.
struct HeadsDownView: View {
    @Bindable var model: HeadsDownModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HeadsDownRunHeader(model: model)
                if model.error != nil || model.refreshing {
                    HStack(spacing: 8) {
                        if let error = model.error { Text(error).font(.caption).foregroundStyle(.red) }
                        if model.refreshing { ProgressView().controlSize(.small) }
                    }
                }
                if let questions = model.questions, !questions.isEmpty {
                    HeadsDownSection("Needs you (\(questions.count))") {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(questions) { q in
                                HeadsDownQuestionCard(model: model, question: q) { model.questionAnswered() }
                            }
                        }
                        // Every card goes inert for a moment when one comes or goes, so a
                        // card that moved under the pointer can't take a click meant for another.
                        .armedAfterAppearing(id: questions.map(\.id).joined(separator: ","))
                    }
                }
                Picker("Heads down", selection: $model.tab) {
                    ForEach(HeadsDownTab.allCases) { Text(tabLabel($0)).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                switch model.tab {
                case .overview: overview
                case .routines: HeadsDownSection("Routines") { HeadsDownRoutineList(model: model) }
                case .history: HeadsDownSection("What it has been doing") { HeadsDownPassList(model: model) }
                case .settings: settings
                }
            }
            .frame(maxWidth: 1100, alignment: .leading)
            .padding(24)
            .frame(maxWidth: .infinity)
        }
        .environment(\.workspaceNames, model.workspaceNames)
        .environment(\.chatLinkRouter, ChatLinkRouter { model.openLink($0) })
        // Workspace mentions in plain text are links too; send them the same way.
        .environment(\.openURL, OpenURLAction { url in
            MainActor.assumeIsolated { model.openLink(url) }
            return .handled
        })
        // The stream runs only while the page is on screen.
        .task { await model.follow() }
    }

    /// A tab's name, with how many routines are on or how many passes finished.
    private func tabLabel(_ tab: HeadsDownTab) -> String {
        let count: Int?
        switch tab {
        case .routines: count = model.routines?.routines.filter(\.enabled).count
        case .history: count = model.passes.map { finishedPasses($0).count }
        case .overview, .settings: count = nil
        }
        return count.map { "\(tab.label) \($0)" } ?? tab.label
    }

    private var overview: some View {
        HStack(alignment: .top, spacing: 24) {
            VStack(alignment: .leading, spacing: 24) {
                if let approvals = model.autoApprovals, !approvals.isEmpty {
                    HeadsDownSection("Approved on its own") { HeadsDownAutoApprovals(approvals: approvals) }
                }
                HeadsDownSection("Work streams") { HeadsDownStreamList(model: model) }
                HeadsDownSection("What it has been doing") {
                    HeadsDownPassList(model: model, limit: recentPasses) { model.tab = .history }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(alignment: .leading, spacing: 24) {
                HeadsDownSection("Tell it something") { HeadsDownMessageBox(model: model) }
            }
            .frame(width: 300, alignment: .leading)
        }
    }

    private var settings: some View {
        HeadsDownSection("Pace, working hours and model") {
            Group {
                if let config = model.config {
                    HeadsDownSettingsView(model: model, config: config)
                } else if let error = model.settingsError {
                    Text("Couldn't load the settings: \(error)").font(.caption).foregroundStyle(.red)
                } else {
                    Text("Loading…").font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: 720, alignment: .leading)
            .task { await model.loadSettings() }
        }
    }
}

/// A titled block of the page.
struct HeadsDownSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A panel's rounded background.
extension View {
    func headsDownCard(tint: Color? = nil) -> some View {
        padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background((tint ?? Color.secondary).opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder((tint ?? Color.secondary).opacity(0.3)))
    }
}

/// Plain text with the id of each known workspace shown as a link to it, by name.
struct HeadsDownMentionText: View {
    let text: String
    @Environment(\.workspaceNames) private var names

    var body: some View {
        Text(headsDownMentions(text, names: names))
    }
}

/// Text with each known workspace id as a `yarvis://workspace/` link named after it.
func headsDownMentions(_ text: String, names: [String: String]) -> AttributedString {
    var out = AttributedString()
    for segment in splitWorkspaceMentions(text, names: names) {
        switch segment {
        case .text(let s): out += AttributedString(s)
        case .workspace(let id, let name):
            var link = AttributedString(name)
            link.link = URL(string: "yarvis://workspace/\(id)")
            out += link
        }
    }
    return out
}

/// The app's mark, showing at a glance whether heads-down mode is working,
/// sleeping between passes, or off. Working spins a ring around it, sleeping
/// dims it, off greys it out.
struct HeadsDownAgentMark: View {
    let state: HeadsDownAgentState
    var size: CGFloat = 40
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var spin = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if state == .working {
                RoundedRectangle(cornerRadius: size * 0.3)
                    .fill(AngularGradient(colors: [.cyan, .purple, .clear, .cyan], center: .center))
                    .frame(width: size + 8, height: size + 8)
                    .rotationEffect(.degrees(spin ? 360 : 0))
                    .frame(width: size, height: size)
                    .onAppear {
                        guard !reduceMotion else { return }
                        withAnimation(.linear(duration: 2.5).repeatForever(autoreverses: false)) { spin = true }
                    }
            }
            Image(systemName: Section.headsDown.symbol)
                .font(.system(size: size * 0.5, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: size, height: size)
                .background(Color.indigo, in: RoundedRectangle(cornerRadius: size * 0.25))
                .saturation(state == .off ? 0 : state == .sleeping ? 0.5 : 1)
                .opacity(state == .off ? 0.4 : state == .sleeping ? 0.6 : 1)
            if state == .sleeping {
                Text("zᶻ").font(.caption.weight(.semibold)).foregroundStyle(.indigo).offset(x: 6, y: -10)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(state.label)
        .help(state.label)
    }
}

// MARK: - The run

/// Start, pause and stop heads-down mode, and see when it runs next and when it stops.
struct HeadsDownRunHeader: View {
    let model: HeadsDownModel
    @State private var focus = ""
    @State private var stopEnabled = false
    @State private var stopTime = Date()
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let state = model.state {
                if let run = state.run {
                    running(state, run)
                } else {
                    startForm
                }
            } else {
                Text("Loading…").foregroundStyle(.secondary)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .headsDownCard()
    }

    private func running(_ state: HeadsDownState, _ run: HeadsDownRun) -> some View {
        let working = model.working
        let agent = HeadsDownAgentState(state: state, working: working)
        let paused = run.pausedAt != nil
        return HStack(alignment: .top, spacing: 16) {
            HeadsDownAgentMark(state: agent)
            VStack(alignment: .leading, spacing: 4) {
                Label {
                    Text(paused ? "Paused since \(headsDownDateTime(run.pausedAt))" : "Heads down since \(headsDownDateTime(run.startedAt))")
                } icon: {
                    Circle().fill(paused ? Color.blue : Color.green).frame(width: 8, height: 8)
                }
                .font(.callout.weight(.medium))
                .foregroundStyle(paused ? Color.blue : Color.green)
                if let focus = run.focus, !focus.isEmpty { Text(focus) }
                Text(NextPass(state: state, run: run, working: working).text { $0.formatted(date: .omitted, time: .standard) })
                    .font(.caption)
                    .foregroundStyle(agent == .working ? Color.cyan : Color.secondary)
                HeadsDownModelLine(model: state.model)
                HeadsDownStopTime(stopAt: run.stopAt, disabled: busy) { stopAt in
                    act { try await $0.setHeadsDownStopAt(stopAt) }
                }
            }
            Spacer()
            HStack(alignment: .top) {
                if paused {
                    HeadsDownClearButton(disabled: busy) { act { try await $0.clearHeadsDown() } }
                }
                Button(paused ? "Resume" : "Pause") {
                    act { paused ? try await $0.resumeHeadsDown() : try await $0.pauseHeadsDown() }
                }
                Button("Stop") { act { try await $0.stopHeadsDown() } }
            }
            .disabled(busy)
        }
    }

    private var startForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                HeadsDownAgentMark(state: .off)
                Text("Heads-down mode keeps your work streams moving while you focus elsewhere. It starts work on "
                     + "tickets, chases CI and reviews, and asks you only what it has to.")
            }
            HStack {
                TextField("What should it push on? (optional)", text: $focus)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(start)
                Toggle("Stop at", isOn: $stopEnabled).toggleStyle(.checkbox)
                DatePicker("Stop at", selection: $stopTime, displayedComponents: .hourAndMinute)
                    .labelsHidden()
                    .disabled(!stopEnabled)
                Button("Go heads down", action: start)
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)
                HeadsDownClearButton(disabled: busy) { act { try await $0.clearHeadsDown() } }
            }
            if let state = model.state { HeadsDownModelLine(model: state.model) }
        }
    }

    private func start() {
        guard !busy else { return }
        let focus = focus.trimmingCharacters(in: .whitespacesAndNewlines)
        let stopAt = stopEnabled ? nextOccurrence(hhmm(stopTime)) : nil
        act {
            try await $0.startHeadsDown(focus: focus, stopAt: stopAt)
        } then: {
            self.focus = ""
            stopEnabled = false
        }
    }

    private func act(_ action: @escaping @Sendable (YarvisClient) async throws -> Void, then: @escaping () -> Void = {}) {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await model.perform(action)
                then()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// Which model passes run on, and whether that is the saved choice or the default chat model.
private struct HeadsDownModelLine: View {
    let model: HeadsDownPassModel?

    var body: some View {
        Text(headsDownModelLine(model)).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
    }
}

/// When the run stops on its own, and a way to set, change or clear it.
private struct HeadsDownStopTime: View {
    let stopAt: String?
    let disabled: Bool
    let onSet: (String?) -> Void
    @State private var time = Date()

    var body: some View {
        HStack(spacing: 8) {
            Text(stopAt.map { "Stops at \(headsDownDateTime($0))" } ?? "Runs until you stop it")
            DatePicker("Stop at", selection: $time, displayedComponents: .hourAndMinute).labelsHidden()
            Button(stopAt == nil ? "Set stop time" : "Change") { onSet(nextOccurrence(hhmm(time))) }
            if stopAt != nil {
                Button("Clear") { onSet(nil) }
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .buttonStyle(.link)
        .disabled(disabled)
    }
}

/// Starts heads-down mode over by dropping its work streams and messages.
/// Asks once more first, since dropped streams leave the page.
struct HeadsDownClearButton: View {
    let disabled: Bool
    let onClear: () -> Void
    @State private var confirming = false

    var body: some View {
        if confirming {
            HStack(spacing: 6) {
                Text("Drop all open work streams, messages and questions?").font(.caption).foregroundStyle(.secondary)
                Button("Yes, clear", role: .destructive) {
                    confirming = false
                    onClear()
                }
                .disabled(disabled)
                Button("Cancel") { confirming = false }
            }
        } else {
            Button("Clear old work") { confirming = true }
                .disabled(disabled)
                .help("Drop every open work stream, delete your messages and dismiss open questions, so the next run starts fresh")
        }
    }
}

// MARK: - Messages

/// A message the next pass reads: direction, new work, a standing instruction.
struct HeadsDownMessageBox: View {
    let model: HeadsDownModel
    @State private var draft = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextEditor(text: $draft)
                .font(.body)
                .frame(height: 64)
                .overlay(alignment: .topLeading) {
                    if draft.isEmpty {
                        Text("e.g. When Alex asks if the billing PR is ready, send him the link")
                            .foregroundStyle(.tertiary).padding(.leading, 5).allowsHitTesting(false)
                    }
                }
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(.quaternary))
                .accessibilityLabel("Message for heads-down mode")
            HStack {
                Button("Send", action: send)
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || trimmed.isEmpty)
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
            }
            ForEach((model.messages ?? []).prefix(10)) { m in
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(headsDownDateTime(m.createdAt)) · \(m.seenAt == nil ? "not read yet" : "read")")
                        .foregroundStyle(.secondary)
                    Text(m.body).textSelection(.enabled)
                }
                .font(.caption)
            }
        }
    }

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func send() {
        let text = trimmed
        guard !busy, !text.isEmpty else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await model.perform { try await $0.sendHeadsDownMessage(text) }
                draft = ""
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// A server timestamp in the user's locale, date and time.
func headsDownDateTime(_ iso: String?) -> String {
    guard let iso, let date = parseISODate(iso) else { return iso ?? "" }
    return date.formatted(date: .abbreviated, time: .shortened)
}
