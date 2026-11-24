import SwiftUI
import YarvisClient

/// Which model passes run on, the user's standing guidance, how often it looks
/// at the work, and when the user works. The working hours are also when it
/// may tag people and merge, and they are kept per machine.
struct HeadsDownSettingsView: View {
    let model: HeadsDownModel
    let config: HeadsDownConfig
    @State private var draft: HeadsDownConfig
    /// The hours to go back to when "any time" is unticked.
    @State private var lastHours: WorkingHours
    @State private var saving = false
    @State private var error: String?

    private static let days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    init(model: HeadsDownModel, config: HeadsDownConfig) {
        self.model = model
        self.config = config
        _draft = State(initialValue: config)
        _lastHours = State(initialValue: config.workingHours ?? .standard)
    }

    private var choice: HeadsDownModelChoice {
        HeadsDownModelChoice(provider: draft.provider, model: draft.model, providers: model.providers)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            modelPicker
            guidance
            Group {
                number("Shortest sleep between passes (min)", \.minSleepMinutes)
                number("Longest sleep (min)", \.maxSleepMinutes)
                number("Sleep when there's little to do (min)", \.idleSleepMinutes)
                number("You count as away after (min)", \.userAwayAfterMinutes)
                number("Longest a pass may run (min, up to 240)", \.passTimeoutMinutes, range: 1...240)
                // 0 is how routines are turned off; past 10 the sidecar refuses the save.
                number("Routines per pass (0 for none)", \.maxRoutinesPerPass, range: 0...10)
            }
            Divider()
            workingHours
            Divider()
            allowedTools
            HStack {
                Button("Save", action: save).buttonStyle(.borderedProminent).disabled(saving)
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
            }
        }
        .font(.callout)
        .onChange(of: config) { _, fresh in
            draft = fresh
            if let hours = fresh.workingHours { lastHours = hours }
        }
    }

    private var modelPicker: some View {
        let choice = choice
        let unavailable = choice.providers == nil ? "" : " (unavailable)"
        return VStack(alignment: .leading, spacing: 4) {
            Text("Model passes run on")
            HStack {
                Picker("Heads-down provider", selection: Binding(
                    get: { draft.provider ?? "" },
                    set: { picked in
                        let next = choice.picking(provider: picked.isEmpty ? nil : picked)
                        draft.provider = next.provider
                        draft.model = next.model
                    })) {
                    Text("Default chat model").tag("")
                    if choice.providerMissing, let p = draft.provider { Text(p + unavailable).tag(p) }
                    ForEach(model.providers ?? []) { p in
                        Text(p.label + (p.available ? "" : " (no key)")).tag(p.id).selectionDisabled(!p.available)
                    }
                }
                Picker("Heads-down model", selection: Binding(get: { draft.model ?? "" }, set: { draft.model = $0 })) {
                    if choice.modelMissing, let m = draft.model { Text(m + unavailable).tag(m) }
                    ForEach(choice.models(for: draft.provider), id: \.id) { Text($0.id).tag($0.id) }
                }
                .disabled(draft.provider == nil)
            }
            .labelsHidden()
            if choice.stale {
                Text("This model is no longer in the catalogue or its provider has no key, so passes will fail until you pick another.")
                    .font(.caption).foregroundStyle(.orange)
            }
            Text("Every pass is a full agent turn, so a cheaper model keeps the cost down. The change applies from the next pass.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var guidance: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Standing guidance")
            TextEditor(text: Binding(
                get: { draft.guidance ?? "" },
                set: { draft.guidance = $0.isEmpty ? nil : String($0.prefix(4000)) }))
                .frame(height: 80)
                .overlay(alignment: .topLeading) {
                    if (draft.guidance ?? "").isEmpty {
                        Text("e.g. Don't merge PRs between 9:30 and 16:00 ET. Merging is fine on my personal repos at any time.")
                            .foregroundStyle(.tertiary).padding(.leading, 5).allowsHitTesting(false)
                    }
                }
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(.quaternary))
                .accessibilityLabel("Standing guidance")
            Text("Every pass follows this, on this machine only. It can't override asking you for approval.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func number(_ label: String, _ key: WritableKeyPath<HeadsDownConfig, Int>,
                        range: ClosedRange<Int> = 1...(7 * 24 * 60)) -> some View {
        LabeledContent(label) {
            TextField(label, value: Binding(
                get: { draft[keyPath: key] },
                // A value out of range isn't a setting; keep the last one.
                set: { if range.contains($0) { draft[keyPath: key] = $0 } }),
                format: .number)
                .labelsHidden()
                .multilineTextAlignment(.trailing)
                .frame(width: 64)
        }
    }

    @ViewBuilder private var workingHours: some View {
        Toggle("Any time is fine to tag people", isOn: Binding(
            get: { draft.workingHours == nil },
            set: { draft.workingHours = $0 ? nil : lastHours }))
            .toggleStyle(.checkbox)
        if let hours = draft.workingHours {
            HStack(spacing: 4) {
                ForEach(Array(Self.days.enumerated()), id: \.offset) { day, name in
                    let on = hours.days.contains(day)
                    Button(name) { setHours(hours.toggling(day: day)) }
                        .buttonStyle(.plain)
                        .font(.caption)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(on ? Color.indigo : .clear, in: RoundedRectangle(cornerRadius: 4))
                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(on ? .clear : Color.secondary.opacity(0.4)))
                        .foregroundStyle(on ? .white : .secondary)
                        .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            HStack {
                Text("From")
                timePicker("Working hours start", hours.start) { setHours(WorkingHours(days: hours.days, start: $0, end: hours.end)) }
                Text("to")
                timePicker("Working hours end", hours.end) { setHours(WorkingHours(days: hours.days, start: hours.start, end: $0)) }
            }
            Text("Outside these hours it sleeps longer, and doesn't tag anyone or bump review requests. "
                 + "An end at or before the start runs past midnight.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func timePicker(_ label: String, _ value: String, set: @escaping (String) -> Void) -> some View {
        DatePicker(label, selection: Binding(
            get: { dateForHHMM(value) ?? Date() },
            set: { set(hhmm($0)) }), displayedComponents: .hourAndMinute)
            .labelsHidden()
    }

    private func setHours(_ next: WorkingHours) {
        lastHours = next
        draft.workingHours = next
    }

    private var allowedTools: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("MCP tools it may use without asking")
            let tools = model.allowedTools ?? []
            if tools.isEmpty {
                Text("None. Allow one from its approval under Needs you.").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(tools) { tool in
                HStack {
                    Text(tool.name).font(.caption.monospaced()).lineLimit(1).help(tool.id)
                    Spacer()
                    Button("Remove") { removeTool(tool.id) }
                        .buttonStyle(.link)
                        .font(.caption)
                        .accessibilityLabel("Stop allowing \(tool.name)")
                }
            }
            Text("Auto-approval from the Tool manager is for chats you're watching, so it doesn't apply here, and a tool "
                 + "that changes has to be allowed again. Every other MCP tool waits for your approval.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func removeTool(_ id: String) {
        error = nil
        Task {
            do {
                try await model.performSetting { try await $0.setHeadsDownToolAllowed(id, allowed: false) }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func save() {
        saving = true
        error = nil
        let draft = draft
        Task {
            defer { saving = false }
            do {
                try await model.performSetting { try await $0.saveHeadsDownConfig(draft) }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
