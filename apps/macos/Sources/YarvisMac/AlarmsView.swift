import SwiftUI
import YarvisClient

/// The Alarms page: set one, see what's ringing and what's coming.
struct AlarmsView: View {
    let model: AlarmsModel
    @State private var label = ""
    @State private var when = Date().addingTimeInterval(5 * 60)

    var body: some View {
        Form {
            SwiftUI.Section("New alarm") {
                HStack {
                    TextField("Label", text: $label, prompt: Text("Label (e.g. Standup)"))
                        .labelsHidden()
                        .onSubmit(add)
                    DatePicker("Alarm time", selection: $when)
                        .labelsHidden()
                    Button("Set", action: add)
                        .buttonStyle(.borderedProminent)
                        .disabled(label.trimmingCharacters(in: .whitespaces).isEmpty)
                    Button("Test in 5s") { Task { await model.test(label: label) } }
                        .help("Fire a test alarm in 5 seconds")
                }
            }
            // Several alarms set for the same time fire together and the
            // takeover shows one at a time, so the rest stay reachable here.
            if !model.ringing.isEmpty {
                SwiftUI.Section {
                    ForEach(model.ringing) { alarm in
                        HStack {
                            Circle().fill(.red).frame(width: 8, height: 8)
                            AlarmRowText(alarm: alarm)
                            Spacer()
                            Button("Snooze 5 min") { Task { await model.snooze(alarm) } }
                            Button("Dismiss") { Task { await model.acknowledge(alarm) } }
                                .buttonStyle(.borderedProminent)
                        }
                    }
                } header: {
                    Text("Ringing (\(model.ringing.count))").foregroundStyle(.red)
                }
            }
            SwiftUI.Section("Upcoming (\(model.scheduled.count))") {
                if model.scheduled.isEmpty {
                    Text("No alarms set.").foregroundStyle(.secondary)
                }
                ForEach(model.scheduled) { alarm in
                    HStack {
                        AlarmRowText(alarm: alarm)
                        Spacer()
                        Button("Cancel", role: .destructive) { Task { await model.cancel(alarm) } }
                            .buttonStyle(.link)
                    }
                }
            }
            if let error = model.error {
                Text(error).foregroundStyle(.red)
            }
        }
        .formStyle(.grouped)
        .task { await model.refresh() }
    }

    private func add() {
        Task {
            if await model.create(label: label, at: when) { label = "" }
        }
    }
}

private struct AlarmRowText: View {
    let alarm: Alarm

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(alarm.label).lineLimit(1)
            Text(alarm.fireAt, format: .dateTime).font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// Covers the main window while an alarm this run saw fire is unanswered, on
/// every page. One at a time, oldest first; answering one shows the next.
struct AlarmTakeoverView: View {
    let model: AlarmsModel
    let alarm: Alarm
    /// How many more are waiting behind this one.
    let remaining: Int

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let overdue = secondsOverdue(alarm, now: context.date)
            let escalated = overdue >= alarmEscalationSeconds
            VStack(spacing: 28) {
                Text("ALARM").font(.callout).tracking(6).foregroundStyle(.secondary)
                Text(alarm.label)
                    .font(.system(size: 44, weight: .semibold))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 640)
                if escalated {
                    Text("Overdue by \(overdue)s — please acknowledge").foregroundStyle(.red)
                }
                if remaining > 0 {
                    Text("\(remaining) more \(remaining == 1 ? "alarm" : "alarms") waiting behind this one")
                        .foregroundStyle(.secondary)
                }
                if let error = model.takeoverError[alarm.id] {
                    Text(error).foregroundStyle(.red).multilineTextAlignment(.center).frame(maxWidth: 520)
                }
                HStack(spacing: 14) {
                    if let link = alarm.meetLink {
                        Button("Join meeting") {
                            openExternal(link)
                            Task { await model.answerTakeover(alarm, snooze: false) }
                        }
                        .tint(.green)
                    }
                    Button("Acknowledge") { Task { await model.answerTakeover(alarm, snooze: false) } }
                        .keyboardShortcut(.defaultAction)
                    Button("Snooze 5 min") { Task { await model.answerTakeover(alarm, snooze: true) } }
                        .buttonStyle(.bordered)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            .padding(40)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(escalated ? Color.red.opacity(context.date.timeIntervalSince1970.truncatingRemainder(dividingBy: 2) < 1 ? 0.35 : 0.2)
                                  : Color(nsColor: .windowBackgroundColor))
            .background(.ultraThickMaterial)
        }
        .id(alarm.id)
    }
}

/// The bell panel's list of alarms that fired and nobody answered. Shown only
/// while something rings.
struct AlarmRingingSection: View {
    let alarms: AlarmsModel
    let openAlarms: () -> Void

    var body: some View {
        SwiftUI.Section("Ringing") {
            ForEach(alarms.ringing) { alarm in
                HStack(alignment: .top) {
                    Circle().fill(.red).frame(width: 8, height: 8).padding(.top, 5)
                    Button(action: openAlarms) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(alarm.label).bold().lineLimit(1)
                            Text(alarm.fireAt, style: .relative).font(.caption).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Button("Snooze") { Task { await alarms.snooze(alarm) } }
                    Button("Dismiss") { Task { await alarms.acknowledge(alarm) } }
                }
            }
        }
    }
}
