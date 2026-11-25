import Foundation

/// The alarm list as this app knows it, and what is ringing.
///
/// `ringing` is every alarm that fired and nobody has dealt with.
/// `takeoverQueue` is the part of that this app run saw fire: an alarm left
/// ringing by an earlier run is listed, but must not take over the window at
/// launch. The derived lists are worked out once per change, since every page
/// and the bell read them.
public struct AlarmBook: Sendable, Equatable {
    /// In the sidecar's order, which is creation order.
    public private(set) var alarms: [Alarm] = []
    /// Ids whose `alarm.fire` arrived during this run.
    public private(set) var firedThisRun: Set<String> = []

    /// Fired and not dealt with, oldest first.
    public private(set) var ringing: [Alarm] = []
    /// What the takeover shows, one at a time, oldest first. Several alarms set
    /// for the same minute all fire together.
    public private(set) var takeoverQueue: [Alarm] = []
    /// Waiting to ring, soonest first.
    public private(set) var scheduled: [Alarm] = []
    /// The scheduled alarms, for asking whether a meeting has one.
    public private(set) var meetingAlarms = MeetingAlarmIndex([])

    public init() {}

    /// Takes a fresh list from the sidecar. True when anything changed.
    @discardableResult
    public mutating func load(_ list: [Alarm]) -> Bool {
        let before = self
        alarms = list
        // Forget ids that stopped ringing, so the set stays small.
        firedThisRun.formIntersection(list.filter(\.isRinging).map(\.id))
        derive()
        return before != self
    }

    /// An `alarm.fire` arrived. The takeover rises straight off the payload,
    /// rather than after the list is read again, so it shows even when that
    /// read fails.
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
        derive()
        return before != self
    }

    /// An `alarm.fire` whose alarm couldn't be read, but whose id could. A
    /// listed alarm takes over at once; any other does once the list is read
    /// again, since the sidecar marks it fired before the event is sent.
    @discardableResult
    public mutating func fired(id: String) -> Bool {
        let before = self
        if let i = alarms.firstIndex(where: { $0.id == id }) { alarms[i].status = "fired" }
        firedThisRun.insert(id)
        derive()
        return before != self
    }

    private mutating func derive() {
        ringing = alarms.filter(\.isRinging).sorted { $0.fireAtMs < $1.fireAtMs }
        takeoverQueue = ringing.filter { firedThisRun.contains($0.id) }
        scheduled = alarms.filter(\.isScheduled).sorted { $0.fireAtMs < $1.fireAtMs }
        meetingAlarms = MeetingAlarmIndex(scheduled)
    }
}

// MARK: - Server events

/// What an `alarm.fire` event carried.
public enum AlarmFire: Equatable, Sendable {
    case alarm(Alarm)
    /// The payload didn't read as an alarm, but named one.
    case id(String)
    /// Nothing usable; read the list again.
    case unreadable

    public init(_ event: ServerEvent) {
        if let data = try? JSONEncoder().encode(event.data),
           let alarm = try? JSONDecoder().decode(Alarm.self, from: data) {
            self = .alarm(alarm)
        } else if let id = event.data["id"]?.stringValue, !id.isEmpty {
            self = .id(id)
        } else {
            self = .unreadable
        }
    }
}

/// The alarm an `alarm.release` event says was dealt with somewhere.
public func releasedAlarmId(_ event: ServerEvent) -> String? {
    event.data["id"]?.stringValue
}

// MARK: - Ringing

/// Which alarms this app is sounding. An alarm the user answered here goes
/// quiet at once and stays quiet while a list read that started before the
/// answer still calls it ringing. It rings again only after it leaves the
/// takeover queue (snoozed, say) and fires once more.
public struct AlarmRingState: Sendable, Equatable {
    public private(set) var sounding: Set<String> = []
    /// Answered here, still in the queue until the list catches up.
    public private(set) var answered: Set<String> = []

    public init() {}

    /// Lines the state up with the takeover queue. Returns the alarms to start
    /// and the ids to stop.
    @discardableResult
    public mutating func sync(queue: [Alarm]) -> (start: [Alarm], stop: [String]) {
        let ids = Set(queue.map(\.id))
        let stop = sounding.subtracting(ids).sorted()
        sounding.formIntersection(ids)
        answered.formIntersection(ids)
        let start = queue.filter { !sounding.contains($0.id) && !answered.contains($0.id) }
        sounding.formUnion(start.map(\.id))
        return (start, stop)
    }

    /// The user answered it here, or another device did. True when it was sounding.
    @discardableResult
    public mutating func answer(_ id: String) -> Bool {
        answered.insert(id)
        return sounding.remove(id) != nil
    }

    /// A fresh `alarm.fire` for it: ring again even if it was answered before.
    public mutating func fired(_ id: String) {
        answered.remove(id)
    }

    public mutating func reset() {
        self = AlarmRingState()
    }
}

/// How long an unanswered alarm rings before it escalates: the takeover turns
/// red and the sound gets louder and more frequent.
public let alarmEscalationSeconds = 60

/// The snooze every button offers.
public let alarmSnoozeMinutes = 5

/// Whole seconds since an alarm's time, never negative.
public func secondsOverdue(_ alarm: Alarm, now: Date = Date()) -> Int {
    max(0, Int(now.timeIntervalSince(alarm.fireAt).rounded(.down)))
}

/// One chime of the alarm sound. The desktop app's ringer
/// (`src-tauri/src/alarms.rs`) plays the same built-in sounds at the same gaps.
public struct AlarmChime: Equatable, Sendable {
    /// A sound in `/System/Library/Sounds`.
    public var sound: String
    /// 0 to 1, of the Mac's output volume.
    public var volume: Float
    /// Seconds until the next chime.
    public var gap: Double

    public static func at(secondsOverdue: Int) -> AlarmChime {
        secondsOverdue >= alarmEscalationSeconds
            ? AlarmChime(sound: "Submarine", volume: 1, gap: 2)
            : AlarmChime(sound: "Ping", volume: 0.5, gap: 5)
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
        MeetingAlarmIndex(alarms).existing(for: event)
    }
}

/// Scheduled alarms by label, so each calendar cell's lookup doesn't scan the
/// whole list.
public struct MeetingAlarmIndex: Sendable, Equatable {
    private var byLabel: [String: [Alarm]] = [:]

    public init(_ alarms: [Alarm]) {
        for alarm in alarms where alarm.isScheduled { byLabel[alarm.label, default: []].append(alarm) }
    }

    public func existing(for event: CalendarEvent) -> Alarm? {
        guard let fireAt = MeetingAlarm.fireAt(event) else { return nil }
        let ms = YarvisClient.epochMs(fireAt)
        return byLabel[MeetingAlarm.label(event)]?.first { abs($0.fireAtMs - ms) < MeetingAlarm.toleranceMs }
    }
}

/// Meeting alarms asked for and not yet answered, so a double click, or Set
/// alarms for all racing a single Set, makes one alarm.
public struct MeetingArming: Sendable, Equatable {
    private var pending: Set<String> = []

    public init() {}

    private static func key(_ event: CalendarEvent) -> String? {
        MeetingAlarm.fireAt(event).map { "\(MeetingAlarm.label(event))\u{0}\(YarvisClient.epochMs($0))" }
    }

    public func isPending(_ event: CalendarEvent) -> Bool {
        Self.key(event).map(pending.contains) ?? false
    }

    /// Claims the event. False when a request for it is already out.
    public mutating func begin(_ event: CalendarEvent) -> Bool {
        guard let key = Self.key(event) else { return false }
        return pending.insert(key).inserted
    }

    public mutating func end(_ event: CalendarEvent) {
        if let key = Self.key(event) { pending.remove(key) }
    }
}
