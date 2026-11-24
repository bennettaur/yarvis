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

    private(set) var book = AlarmBook()
    var alarms: [Alarm] { book.alarms }
    var ringing: [Alarm] { book.ringing }
    var takeoverQueue: [Alarm] { book.takeoverQueue }
    var scheduled: [Alarm] { book.scheduled }
    /// The page's last failed action.
    var error: String?
    /// The takeover's last failed action, keyed by alarm id.
    var takeoverError: [String: String] = [:]

    private let ringer = AlarmRinger()
    /// Bumped per list read, so an older answer that lands last is dropped. A
    /// read sent before a dismissal must not put the alarm back on screen.
    private var listGeneration = 0
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
                await self?.refresh()
            }
        }
        streamTask = Task { [weak self] in await self?.followChanges() }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        streamTask?.cancel()
        streamTask = nil
        ringer.stopAll()
    }

    func handle(_ event: ServerEvent) {
        switch event.kind {
        case "alarm.fire":
            guard let data = try? JSONEncoder().encode(event.data),
                  let alarm = try? JSONDecoder().decode(Alarm.self, from: data) else {
                resync()
                return
            }
            book.fired(alarm)
            syncRinger()
            resync()
        case "alarm.release":
            // Dealt with on another device. Stop the sound now; the list
            // read below drops it from the takeover.
            if let id = event.data["id"]?.stringValue { ringer.stop(id: id) }
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
        listGeneration += 1
        let generation = listGeneration
        guard let list = try? await client.alarms(), generation == listGeneration else { return }
        book.load(list)
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

    /// Rings in five seconds, to check sound and notifications work.
    func test(label: String) async {
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
        await run { [client] in try await client.acknowledgeAlarm(id: alarm.id) }
    }

    func snooze(_ alarm: Alarm, minutes: Int = 5) async {
        await run { [client] in try await client.snoozeAlarm(id: alarm.id, minutes: minutes) }
    }

    /// The takeover's actions. The sound stops at once, even when the sidecar
    /// can't be reached; the error says the choice wasn't recorded.
    func answerTakeover(_ alarm: Alarm, snooze: Bool) async {
        ringer.stop(id: alarm.id)
        takeoverError[alarm.id] = nil
        do {
            if snooze {
                try await client.snoozeAlarm(id: alarm.id, minutes: 5)
            } else {
                try await client.acknowledgeAlarm(id: alarm.id)
            }
        } catch {
            takeoverError[alarm.id] = "Couldn't reach Yarvis to record that (\(error.localizedDescription)). Try again."
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

    func isArmed(_ event: CalendarEvent) -> Bool {
        MeetingAlarm.existing(for: event, in: book.alarms) != nil
    }

    /// Sets the alarm for a meeting, unless it has started or one is set.
    func arm(_ event: CalendarEvent) async {
        guard MeetingAlarm.isArmable(event), !isArmed(event), let fireAt = MeetingAlarm.fireAt(event) else { return }
        await run { [client] in
            try await client.createAlarm(label: MeetingAlarm.label(event), fireAt: fireAt, meetLink: event.meetLink)
        }
    }
}

/// Makes a ringing alarm noticeable when Yarvis isn't the app in front: a
/// looping sound, a notification, and a Dock icon that bounces until the user
/// comes back. It doesn't pull the window forward: macOS 14 refuses focus
/// stealing, and a window that jumps forward while the user types can catch
/// keystrokes meant for another app.
@MainActor
final class AlarmRinger {
    private var ringingIds: Set<String> = []
    private var sounds: [String: NSSound] = [:]
    /// Ids the user already answered here, so a list read that still says
    /// `fired` doesn't start the sound again.
    private var silenced: Set<String> = []
    private var attentionRequest: Int?

    func sync(queue: [Alarm]) {
        let ids = Set(queue.map(\.id))
        for id in ringingIds where !ids.contains(id) { stop(id: id) }
        silenced.formIntersection(ids)
        for alarm in queue where !ringingIds.contains(alarm.id) && !silenced.contains(alarm.id) {
            ring(alarm)
        }
        if queue.isEmpty { endAttention() }
    }

    private func ring(_ alarm: Alarm) {
        ringingIds.insert(alarm.id)
        if alarm.sound, let sound = NSSound(named: "Sosumi")?.copy() as? NSSound {
            sound.loops = true
            sound.play()
            sounds[alarm.id] = sound
        }
        Notifier.post(id: Self.notificationId(alarm.id), title: "Alarm", body: alarm.label)
        if !NSApp.isActive, attentionRequest == nil {
            attentionRequest = NSApp.requestUserAttention(.criticalRequest)
        }
    }

    func stop(id: String) {
        silenced.insert(id)
        ringingIds.remove(id)
        sounds.removeValue(forKey: id)?.stop()
        if Notifier.available {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [Self.notificationId(id)])
        }
        if ringingIds.isEmpty { endAttention() }
    }

    func stopAll() {
        for id in ringingIds { stop(id: id) }
        silenced = []
        endAttention()
    }

    private func endAttention() {
        if let request = attentionRequest { NSApp.cancelUserAttentionRequest(request) }
        attentionRequest = nil
    }

    private static func notificationId(_ id: String) -> String { "alarm.\(id)" }
}
