import SwiftUI
import YarvisClient

/// The routines passes take on: which ones the next pass runs, why the rest
/// wait, each one's instructions, and a way to turn one on or off or add one.
struct HeadsDownRoutineList: View {
    let model: HeadsDownModel
    @State private var busy = false
    @State private var error: String?
    @State private var adding = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let data = model.routines {
                list(data)
            } else if let loadError = model.routinesError {
                Text("Couldn't load the routines: \(loadError)").font(.caption).foregroundStyle(.red)
                HStack {
                    reloadButton
                    if let error { Text(error).font(.caption).foregroundStyle(.red) }
                }
            } else {
                Text("Loading…").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private func list(_ data: HeadsDownRoutines) -> some View {
        let on = data.routines.filter(\.enabled)
        let off = data.routines.filter { !$0.enabled }
        VStack(alignment: .leading, spacing: 4) {
            if let warning = routinesOffWarning(running: model.state.map { $0.run != nil }) {
                Text(warning).foregroundStyle(.orange)
            }
            switch HeadsDownRoutineSummary(data) {
            case .noneRun:
                Text(HeadsDownRoutineSummary.noneRunWarning).foregroundStyle(.orange)
            case .next(let line, let limit):
                Text(line) + Text(" ") + Text(limit).foregroundColor(.secondary)
            }
        }
        .font(.callout)

        HStack(spacing: 16) {
            if !adding {
                Button("Add routine") { adding = true }.buttonStyle(.borderedProminent)
            }
            reloadButton
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }

        if adding {
            HeadsDownAddRoutineForm(model: model) { adding = false }
        }

        section("On (\(on.count))", routines: on, empty: "No routines are on.")
        if !off.isEmpty {
            section("Off (\(off.count))", note: "Most shipped routines start off because they need setup or reach "
                    + "other people. Open one to read what it does and what it needs before you turn it on.",
                    routines: off)
        }

        if !data.problems.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(data.problems, id: \.path) { p in
                    Text(p.message).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                }
            }
        }
        Text("Your routines are markdown files in \(data.userDir). A file with the same name as a shipped one "
             + "replaces it. Press Reload files after editing one.")
            .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
    }

    private func section(_ title: String, note: String? = nil, routines: [HeadsDownRoutine],
                         empty: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if let note { Text(note).font(.caption).foregroundStyle(.secondary) }
            if routines.isEmpty {
                if let empty { Text(empty).font(.caption).foregroundStyle(.secondary) }
            } else {
                ForEach(routines, id: \.name) { r in
                    HeadsDownRoutineRow(routine: r, busy: busy) {
                        act { try await model.setRoutineEnabled(r.name, enabled: !r.enabled) }
                    } onDelete: {
                        act { try await model.deleteRoutine(r.name) }
                    }
                }
            }
        }
    }

    private var reloadButton: some View {
        Button("Reload files") { act { try await model.reloadRoutines() } }
            .buttonStyle(.link)
            .disabled(busy)
    }

    private func act(_ action: @escaping () async throws -> Void) {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await action()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// One routine: its name, cadence and status, with its file's details a click away.
private struct HeadsDownRoutineRow: View {
    let routine: HeadsDownRoutine
    let busy: Bool
    let onToggle: () -> Void
    let onDelete: () -> Void
    @State private var open = false
    @State private var confirmingDelete = false

    var body: some View {
        let r = routine
        let status = routineStatus(r) { $0.formatted(.relative(presentation: .named)) }
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                Button { open.toggle() } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: open ? "chevron.down" : "chevron.right")
                                .font(.caption2).foregroundStyle(.secondary)
                            Text(r.name).font(.callout.monospaced())
                            if r.source == "user" { Text("yours").font(.caption).foregroundStyle(.secondary) }
                            Text(describeCadence(r)).font(.caption).foregroundStyle(.secondary)
                            chip(status)
                        }
                        Text(r.description).font(.caption).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(open ? "Hide" : "Show") \(r.name)")
                Button(r.enabled ? "Turn off" : "Turn on", action: onToggle)
                    .disabled(busy)
                    .accessibilityLabel("\(r.enabled ? "Turn off" : "Turn on") \(r.name)")
            }
            if open {
                Divider()
                details(r)
            }
        }
        .headsDownCard()
    }

    @ViewBuilder private func details(_ r: HeadsDownRoutine) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if r.enabled {
                Text(r.lastDoneAt.flatMap(parseISODate).map {
                    "Last done \($0.formatted(.relative(presentation: .named)))"
                } ?? "Not done in the last 30 days")
                .foregroundStyle(.secondary)
            }
            if !r.tools.isEmpty {
                (Text("Tools: ").foregroundColor(.secondary) + Text(r.tools.joined(separator: ", ")).monospaced())
                    .textSelection(.enabled)
            }
            if !r.config.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Settings:").foregroundStyle(.secondary)
                    // Sorted, since JSON objects carry no order a decoder keeps.
                    ForEach(r.config.keys.sorted(), id: \.self) { key in
                        (Text(key).monospaced().foregroundColor(.secondary) + Text(": ")
                            + Text(r.config[key]?.text ?? ""))
                            .padding(.leading, 12)
                            .textSelection(.enabled)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("What a pass is told to do:").foregroundStyle(.secondary)
                Text(r.body)
                    .textSelection(.enabled)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
            }
            if let path = r.path {
                HStack(spacing: 12) {
                    Text(path).monospaced().foregroundStyle(.secondary).textSelection(.enabled)
                    deleteButton(path)
                }
            } else {
                Text("Shipped with Yarvis. To change what it does, save a routine with the same name in your "
                     + "routines folder; it replaces this one.")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption)
    }

    /// Asks once more before deleting, since the file goes with it.
    @ViewBuilder private func deleteButton(_ path: String) -> some View {
        if confirmingDelete {
            HStack(spacing: 8) {
                Text("Delete \(path)? If it replaced a shipped routine, the shipped one comes back.")
                    .foregroundStyle(.secondary)
                Button("Yes, delete", role: .destructive) {
                    confirmingDelete = false
                    onDelete()
                }
                .disabled(busy)
                Button("Cancel") { confirmingDelete = false }
            }
        } else {
            Button("Delete file") { confirmingDelete = true }
                .buttonStyle(.link)
                .disabled(busy)
        }
    }

    private func chip(_ status: HeadsDownRoutineStatus) -> some View {
        let color: Color = switch status.tone {
        case .next: .green
        case .due: .orange
        case .waiting: .secondary
        case .off: Color(nsColor: .tertiaryLabelColor)
        }
        return Text(status.label).font(.caption)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(color.opacity(0.15), in: RoundedRectangle(cornerRadius: 3))
            .foregroundStyle(color)
    }
}

/// A new routine, written to the user's routines folder.
private struct HeadsDownAddRoutineForm: View {
    let model: HeadsDownModel
    let onDone: () -> Void
    @State private var name = ""
    @State private var description = ""
    @State private var once = false
    @State private var every = "1d"
    @State private var workingHours = false
    @State private var nightShift = "run"
    @State private var tools = ""
    @State private var instructions = ""
    @State private var busy = false
    @State private var error: String?

    private func blank(_ s: String) -> Bool { s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Name").font(.caption).foregroundStyle(.secondary)
                    TextField("check-release", text: $name)
                        .textFieldStyle(.roundedBorder)
                        .font(.body.monospaced())
                        .accessibilityLabel("Routine name")
                        .onChange(of: name) { _, value in
                            if value != value.lowercased() { name = value.lowercased() }
                        }
                }
                .frame(width: 220)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Description").font(.caption).foregroundStyle(.secondary)
                    TextField("One line, shown in this list", text: $description)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Routine description")
                }
            }
            HStack(spacing: 16) {
                Picker("Schedule", selection: $once) {
                    Text("Repeats every").tag(false)
                    Text("Once, on the next pass with room").tag(true)
                }
                .pickerStyle(.radioGroup)
                .horizontalRadioGroupLayout()
                .labelsHidden()
                TextField("1d", text: $every)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 70)
                    .disabled(once)
                    .accessibilityLabel("Repeats every")
                    .help("Such as 30m, 3h or 1d. 15m to 30d.")
                Toggle("Working hours only", isOn: $workingHours).toggleStyle(.checkbox)
                Picker("Night shift", selection: $nightShift) {
                    Text("runs as usual").tag("run")
                    Text("runs less often").tag("slow")
                    Text("skipped").tag("skip")
                }
                .fixedSize()
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Tools it uses (optional, comma-separated names from the Tool manager)")
                    .font(.caption).foregroundStyle(.secondary)
                TextField("slack_read_channel, list_events", text: $tools)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                    .accessibilityLabel("Routine tools")
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("What a pass should do, in your own words").font(.caption).foregroundStyle(.secondary)
                TextEditor(text: $instructions)
                    .font(.body)
                    .frame(height: 110)
                    .overlay(alignment: .topLeading) {
                        if instructions.isEmpty {
                            Text("Read the #releases channel since yesterday and leave me a note in the bell listing "
                                 + "what shipped. If nothing shipped, count it as done.")
                                .foregroundStyle(.tertiary).padding(.leading, 5).allowsHitTesting(false)
                        }
                    }
                    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(.quaternary))
                    .accessibilityLabel("Routine instructions")
            }
            Text("A pass runs this with nobody watching. Anything that reaches other people still waits for your "
                 + "approval. You can also ask the assistant in a chat to write one for you.")
                .font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Button("Save routine", action: save)
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || blank(name) || blank(description) || blank(instructions))
                Button("Cancel", action: onDone).buttonStyle(.link)
                if let error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            }
        }
        .headsDownCard()
    }

    private func save() {
        let routine = NewHeadsDownRoutine(
            name: name, description: description, schedule: once ? .once : .every(every),
            workingHours: workingHours, nightShift: nightShift, tools: parseRoutineTools(tools), body: instructions)
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await model.createRoutine(routine)
                onDone()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
