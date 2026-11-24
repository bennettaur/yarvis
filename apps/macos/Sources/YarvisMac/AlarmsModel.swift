import AppKit
import Foundation
import Observation
import UserNotifications
import YarvisClient

/// The alarm list, shared by the Alarms page, the calendar's alarm buttons,
/// the bell and the takeover. It runs for the whole connection, not only
/// while the page shows, since a ringing alarm has to reach the user anywhere.
@MainActor @Observable
final class AlarmsModel {
    private unowned let app: AppModel
    private let client: YarvisClient

    /// Assigned only when a read or event changed it, so views that read it
    /// don't redraw on every poll.
    private(set) var book = AlarmBook()
    var ringing: [Alarm] { book.ringing }
    var takeoverQueue: [Alarm] { book.takeoverQueue }
    var scheduled: [Alarm] { book.scheduled }
    /// The page's last failed action.
    var error: String?
    /// The takeover's last failed action, by alarm id.
    var takeoverErrors: [String: String] = [:]
    private var arming = MeetingArming()

    private let ringer = AlarmRinger()
    /// Bumped per list read, so an older answer that lands last is dropped. A
    /// read sent before a dismissal must not put the alarm back on screen.
    private var listGeneration = 0
    /// Set on sign-out, so nothing still in flight rings or redraws.
    private var stopped = false
    private var pollTask: Task<Void, Never>?
    private var streamTask: Task<Void, Never>?

    /// A backstop for a missed change; the stream and server events do the work.
    private static let pollInterval: Duration = .seconds(30)
    private static let reconnectDelay: Duration = .seconds(5)

    init(app: AppModel, client: YarvisClient) {
        self.app = app
        self.client = client
    }

    func start() {
        resync()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.pollInterval)
                guard let self else { return }
                await self.refresh()
            }
        }
        streamTask = Task { [weak self] in await self?.followChanges() }
    }

    func stop() {
        stopped = true
        listGeneration += 1
        pollTask?.cancel()
        pollTask = nil
        streamTask?.cancel()
        streamTask = nil
        ringer.stopAll()
    }

    func handle(_ event: ServerEvent) {
        guard !stopped else { return }
        switch event.kind {
        case "alarm.fire":
            switch AlarmFire(event) {
            case .alarm(let alarm):
                ringer.fired(alarm.id)
                update { $0.fired(alarm) }
            case .id(let id):
                ringer.fired(id)
                update { $0.fired(id: id) }
            case .unreadable:
                break
            }
            resync()
        case "alarm.release":
            // Dealt with on another device. Stop the sound now; the list
            // read drops it from the takeover.
            if let id = releasedAlarmId(event) { ringer.answer(id) }
            resync()
        default:
            break
        }
    }

    func resync() {
        Task { await refresh() }
    }

    /// Reads the list. A failure keeps the last list; the next poll retries.
    func refresh() async {
        guard !stopped else { return }
        listGeneration += 1
        let generation = listGeneration
        guard let list = try? await client.alarms(), generation == listGeneration, !stopped else { return }
        update { $0.load(list) }
    }

    private func update(_ change: (inout AlarmBook) -> Bool) {
        var next = book
        if change(&next) { book = next }
        syncRinger()
    }

    /// The sidecar's change stream. It replays nothing, so each reconnect
    /// reads the list again.
    private func followChanges() async {
        while !Task.isCancelled {
            do {
                for try await event in try client.alarmStream() where event == .changed {
                    await refresh()
                }
            } catch YarvisError.unauthorized {
                return
            } catch {
                // Dropped or never connected: retried below.
            }
            try? await Task.sleep(for: Self.reconnectDelay)
            await refresh()
        }
    }

    private func syncRinger() {
        guard !stopped else { return }
        ringer.sync(queue: book.takeoverQueue)
    }

    // MARK: Actions

    /// Sets an alarm the user typed. False when it failed, so the form keeps
    /// what was typed.
    func create(label: String, at date: Date) async -> Bool {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        guard await run({ [client] in try await client.createAlarm(label: trimmed, fireAt: date) }) else { return false }
        Task { [client] in try? await client.recordAlarmCreated(label: trimmed, fireAt: date) }
        return true
    }

    /// Rings in five seconds, to check the sound and the takeover work.
    func fireTestAlarm(label: String) async {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        await run { [client] in
            try await client.createAlarm(label: trimmed.isEmpty ? "Test alarm" : trimmed,
                                         fireAt: Date().addingTimeInterval(5))
        }
    }

    func cancel(_ alarm: Alarm) async {
        await run { [client] in try await client.cancelAlarm(id: alarm.id) }
    }

    func acknowledge(_ alarm: Alarm) async {
        ringer.answer(alarm.id)
        await run { [client] in try await client.acknowledgeAlarm(id: alarm.id) }
    }

    func snooze(_ alarm: Alarm) async {
        ringer.answer(alarm.id)
        await run { [client] in try await client.snoozeAlarm(id: alarm.id, minutes: alarmSnoozeMinutes) }
    }

    /// The takeover's actions. The sound stops at once, even when the sidecar
    /// can't be reached; the error says the choice wasn't recorded.
    func answerTakeover(_ alarm: Alarm, snooze: Bool) async {
        ringer.answer(alarm.id)
        takeoverErrors[alarm.id] = nil
        do {
            if snooze {
                try await client.snoozeAlarm(id: alarm.id, minutes: alarmSnoozeMinutes)
            } else {
                try await client.acknowledgeAlarm(id: alarm.id)
            }
        } catch {
            takeoverErrors[alarm.id] = "Couldn't reach Yarvis to record that (\(error.localizedDescription)). Try again."
        }
        await refresh()
    }

    @discardableResult
    private func run(_ action: @escaping @Sendable () async throws -> Void) async -> Bool {
        do {
            try await action()
            error = nil
            await refresh()
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    // MARK: Meeting alarms

    /// Set, or being set.
    func isArmed(_ event: CalendarEvent) -> Bool {
        book.meetingAlarms.existing(for: event) != nil || arming.isPending(event)
    }

    /// Sets the alarm for a meeting, unless it has started or one is set or
    /// being set.
    func arm(_ event: CalendarEvent) async {
        guard MeetingAlarm.isArmable(event), !isArmed(event), let fireAt = MeetingAlarm.fireAt(event),
              arming.begin(event) else { return }
        await run { [client] in
            try await client.createAlarm(label: MeetingAlarm.label(event), fireAt: fireAt, meetLink: event.meetLink)
        }
        arming.end(event)
    }
}

/// Sounds the alarms in the takeover queue, in front or not, and makes them
/// noticeable from the background with a notification and a Dock icon that
/// bounces until the user comes back. It doesn't pull the window forward:
/// macOS 14 refuses focus stealing, and a window that jumps forward while the
/// user types can catch keystrokes meant for another app.
@MainActor
final class AlarmRinger {
    private var state = AlarmRingState()
    /// When each sounding alarm was due, for when to escalate.
    private var dueAt: [String: Date] = [:]
    private var chimeTask: Task<Void, Never>?
    private var attentionRequest: Int?

    func sync(queue: [Alarm]) {
        let (start, stop) = state.sync(queue: queue)
        for id in stop { quiet(id) }
        for alarm in start { ring(alarm) }
        if state.sounding.isEmpty { endAttention() }
    }

    func fired(_ id: String) { state.fired(id) }

    func answer(_ id: String) {
        if state.answer(id) { quiet(id) }
        if state.sounding.isEmpty { endAttention() }
    }

    func stopAll() {
        for id in state.sounding { quiet(id) }
        state.reset()
        endAttention()
    }

    private func ring(_ alarm: Alarm) {
        if alarm.sound { dueAt[alarm.id] = alarm.fireAt }
        Notifier.post(id: Self.notificationId(alarm.id), title: "Alarm", body: alarm.label)
        if !NSApp.isActive, attentionRequest == nil {
            attentionRequest = NSApp.requestUserAttention(.criticalRequest)
        }
        startChiming()
    }

    private func quiet(_ id: String) {
        dueAt[id] = nil
        if dueAt.isEmpty {
            chimeTask?.cancel()
            chimeTask = nil
        }
        if Notifier.available {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [Self.notificationId(id)])
        }
    }

    /// One chime at a time for every sounding alarm, escalating with the
    /// longest overdue of them.
    private func startChiming() {
        guard chimeTask == nil, !dueAt.isEmpty else { return }
        chimeTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let oldest = self.dueAt.values.min() else { return }
                let overdue = max(0, Int(Date().timeIntervalSince(oldest)))
                let chime = AlarmChime.at(secondsOverdue: overdue)
                if let sound = NSSound(named: chime.sound)?.copy() as? NSSound {
                    sound.volume = chime.volume
                    sound.play()
                }
                try? await Task.sleep(for: .seconds(chime.gap))
            }
        }
    }

    private func endAttention() {
        if let request = attentionRequest { NSApp.cancelUserAttentionRequest(request) }
        attentionRequest = nil
    }

    private static func notificationId(_ id: String) -> String { "alarm.\(id)" }
}
