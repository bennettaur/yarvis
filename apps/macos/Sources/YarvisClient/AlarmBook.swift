import Foundation

/// The alarm list as this app knows it, and what is ringing.
///
/// `ringing` is every alarm that fired and nobody has dealt with.
/// `takeoverQueue` is the part of that this app run saw fire: an alarm left
/// ringing by an earlier run is listed, but must not take over the window at
/// launch.
public struct AlarmBook: Sendable, Equatable {
    /// In the sidecar's order, which is creation order.
    public private(set) var alarms: [Alarm] = []
    /// Ids whose `alarm.fire` arrived during this run.
    public private(set) var firedThisRun: Set<String> = []

    public init() {}

    /// Fired and not dealt with, oldest first.
    public var ringing: [Alarm] {
        alarms.filter(\.isRinging).sorted { $0.fireAtMs < $1.fireAtMs }
    }

    /// What the takeover shows, one at a time, oldest first. Several alarms set
    /// for the same minute all fire together.
    public var takeoverQueue: [Alarm] {
        ringing.filter { firedThisRun.contains($0.id) }
    }

    /// Waiting to ring, soonest first.
    public var scheduled: [Alarm] {
        alarms.filter(\.isScheduled).sorted { $0.fireAtMs < $1.fireAtMs }
    }

    /// Takes a fresh list from the sidecar. True when anything shown changed.
    @discardableResult
    public mutating func load(_ list: [Alarm]) -> Bool {
        let before = self
        alarms = list
        // Forget ids that stopped ringing, so the set stays small.
        let stillRinging = Set(list.filter(\.isRinging).map(\.id))
        firedThisRun.formIntersection(stillRinging)
        return before != self
    }

    /// An `alarm.fire` arrived. The takeover rises straight off the payload,
    /// rather than after the list is read again, so it shows even when that read
    /// fails.
    @discardableResult
    public mutating func fired(_ alarm: Alarm) -> Bool {
        let before = self
        var alarm = alarm
        alarm.status = "fired"
        if let i = alarms.firstIndex(where: { $0.id == alarm.id }) {
            // The payload has no `source`; keep the one the list had.
            alarm.source = alarm.source ?? alarms[i].source
            alarms[i] = alarm
        } else {
            alarms.append(alarm)
        }
        firedThisRun.insert(alarm.id)
        return before != self
    }
}

// MARK: - Meeting alarms

/// How meeting alarms are named and timed. The sidecar's
/// `sidecar/src/alarms/service.ts` sets them for the agents with the same lead,
/// label and tolerance, so the calendar shows those as already set.
public enum MeetingAlarm {
    /// Rings a minute before the start. The takeover escalates about a minute
    /// later, around the start, if nobody answered it.
    public static let leadMinutes = 1
    static let labelPrefix = "Meeting: "
    /// How far apart an alarm's time and the meeting's alarm time may be and
    /// still count as the same alarm.
    static let toleranceMs: Int64 = 90_000

    /// Only timed events that haven't started can have an alarm.
    public static func isArmable(_ event: CalendarEvent, now: Date = Date()) -> Bool {
        guard !event.allDay, let start = event.startDate else { return false }
        return start > now
    }

    public static func label(_ event: CalendarEvent) -> String { labelPrefix + event.title }

    public static func fireAt(_ event: CalendarEvent) -> Date? {
        event.startDate.map { $0.addingTimeInterval(-Double(leadMinutes) * 60) }
    }

    /// The scheduled alarm already set for this event, matched on label and a
    /// near-equal time.
    public static func existing(for event: CalendarEvent, in alarms: [Alarm]) -> Alarm? {
        guard let fireAt = fireAt(event) else { return nil }
        let ms = YarvisClient.epochMs(fireAt)
        let label = label(event)
        return alarms.first { $0.isScheduled && $0.label == label && abs($0.fireAtMs - ms) < toleranceMs }
    }
}

/// Whole seconds since an alarm's time, never negative. At a minute the
/// takeover escalates.
public func secondsOverdue(_ alarm: Alarm, now: Date = Date()) -> Int {
    max(0, Int(now.timeIntervalSince(alarm.fireAt).rounded(.down)))
}

public let alarmEscalationSeconds = 60
