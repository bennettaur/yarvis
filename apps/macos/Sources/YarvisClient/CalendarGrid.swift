import Foundation

/// Date maths and day-layout rules for the calendar's agenda, week, month and
/// day views. Everything works in `calendar`'s time zone, which is the Mac's
/// own unless a test pins one. Weeks start on Sunday whatever the locale says,
/// so the grids line up with the web UI's.
public struct CalendarGrid: Sendable {
    public var calendar: Calendar

    public static let minutesPerDay = 24 * 60
    /// The shortest an event is drawn, so a zero-length one stays clickable.
    public static let minimumMinutes = 15
    /// Days in the month grid: six weeks, so its height doesn't change by month.
    public static let monthCells = 42

    public init(calendar: Calendar = .current) {
        var calendar = calendar
        calendar.firstWeekday = 1
        self.calendar = calendar
    }

    // MARK: Days, weeks and months

    public func startOfDay(_ date: Date) -> Date { calendar.startOfDay(for: date) }

    public func addDays(_ date: Date, _ days: Int) -> Date {
        calendar.date(byAdding: .day, value: days, to: date) ?? date
    }

    /// Midnight on the Sunday on or before `date`.
    public func startOfWeek(_ date: Date) -> Date {
        let day = startOfDay(date)
        let weekday = calendar.component(.weekday, from: day)
        return addDays(day, -(weekday - 1))
    }

    /// The seven day-starts of `date`'s week, Sunday first.
    public func weekDays(_ date: Date) -> [Date] {
        let start = startOfWeek(date)
        return (0..<7).map { addDays(start, $0) }
    }

    /// Midnight on the first of `date`'s month.
    public func startOfMonth(_ date: Date) -> Date {
        let parts = calendar.dateComponents([.year, .month], from: date)
        return calendar.date(from: parts).map(startOfDay) ?? startOfDay(date)
    }

    public func addMonths(_ date: Date, _ months: Int) -> Date {
        let first = startOfMonth(date)
        return calendar.date(byAdding: .month, value: months, to: first) ?? first
    }

    /// The month's days plus the days before and after that fill out whole
    /// Sunday-to-Saturday weeks. Always `monthCells` long.
    public func monthGridDays(_ date: Date) -> [Date] {
        let start = startOfWeek(startOfMonth(date))
        return (0..<Self.monthCells).map { addDays(start, $0) }
    }

    public func sameDay(_ a: Date, _ b: Date) -> Bool { calendar.isDate(a, inSameDayAs: b) }

    public func sameMonth(_ a: Date, _ b: Date) -> Bool {
        calendar.isDate(a, equalTo: b, toGranularity: .month)
    }

    /// `YYYY-MM-DD` for the local day, the form all-day events use.
    public func dayKey(_ date: Date) -> String {
        let p = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", p.year ?? 0, p.month ?? 0, p.day ?? 0)
    }

    /// Minutes from local midnight, with the seconds dropped.
    public func minutesIntoDay(_ date: Date) -> Int {
        let p = calendar.dateComponents([.hour, .minute], from: date)
        return (p.hour ?? 0) * 60 + (p.minute ?? 0)
    }

    // MARK: Ranges the views load

    /// `[start, end)` the week view loads.
    public func weekRange(_ anchor: Date) -> Range<Date> {
        let start = startOfWeek(anchor)
        return start..<addDays(start, 7)
    }

    /// `[start, end)` the month view loads: every cell, leading and trailing days included.
    public func monthRange(_ anchor: Date) -> Range<Date> {
        let days = monthGridDays(anchor)
        return days[0]..<addDays(days[Self.monthCells - 1], 1)
    }

    /// `[start, end)` of one local day. Not a fixed 24 hours: a day with a
    /// clock change is 23 or 25.
    public func dayRange(_ day: Date) -> Range<Date> {
        let start = startOfDay(day)
        return start..<addDays(start, 1)
    }

    // MARK: Putting events on days

    /// The events that touch `day`: all-day ones in the order given, and
    /// timed ones sorted by start.
    public func eventsForDay(_ events: [CalendarEvent], day: Date) -> (allDay: [CalendarEvent], timed: [CalendarEvent]) {
        let range = dayRange(day)
        let key = dayKey(day)
        var allDay: [CalendarEvent] = []
        var timed: [CalendarEvent] = []
        for event in events {
            if event.allDay {
                if Self.allDay(event, covers: key) { allDay.append(event) }
                continue
            }
            guard let start = event.startDate else { continue }
            let end = event.endDate ?? start
            // A zero-length event at midnight belongs to the day it starts.
            if start < range.upperBound && (end > range.lowerBound || start == range.lowerBound) {
                timed.append(event)
            }
        }
        timed.sort { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) }
        return (allDay, timed)
    }

    /// All-day events carry date-only strings with an exclusive end. They are
    /// compared as dates, since reading them as instants would shift them by
    /// the time zone.
    static func allDay(_ event: CalendarEvent, covers key: String) -> Bool {
        let start = String(event.start.prefix(10))
        let endPrefix = String(event.end.prefix(10))
        // A missing end means a one-day event.
        if endPrefix.isEmpty { return start == key }
        return start <= key && key < endPrefix
    }

    /// The local day an event starts on. An all-day event's date is read as a
    /// local date, not an instant.
    public func startDay(_ event: CalendarEvent) -> Date? {
        if event.allDay {
            let parts = event.start.prefix(10).split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return nil }
            return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
        }
        return event.startDate.map(startOfDay)
    }

    /// Every day's events in `range`, keyed by `dayKey`, worked out once per
    /// load rather than on every redraw. Timed events come with their columns.
    public func buckets(_ events: [CalendarEvent], in range: Range<Date>) -> [String: CalendarDayBucket] {
        var result: [String: CalendarDayBucket] = [:]
        var day = startOfDay(range.lowerBound)
        while day < range.upperBound {
            let split = eventsForDay(events, day: day)
            result[dayKey(day)] = CalendarDayBucket(allDay: split.allDay, laid: assignLanes(split.timed))
            day = addDays(day, 1)
        }
        return result
    }

    /// The agenda's sections: events grouped by the day they start, earliest first.
    public func groupByDay(_ events: [CalendarEvent]) -> [(day: Date, events: [CalendarEvent])] {
        var groups: [Date: [CalendarEvent]] = [:]
        for event in events {
            guard let day = startDay(event) else { continue }
            groups[day, default: []].append(event)
        }
        return groups.keys.sorted().map { ($0, groups[$0] ?? []) }
    }

    /// Where a timed event sits on `day`'s 24-hour axis, in wall-clock
    /// minutes from midnight. Wall-clock minutes keep events on the evenly
    /// spaced hour lines on a day the clocks change. Clamped to the day, so one
    /// that starts the day before or ends the day after still shows the part
    /// inside it. An event with no end is drawn as 30 minutes.
    public func placement(_ event: CalendarEvent, day: Date) -> (startMinute: Double, minutes: Double) {
        let range = dayRange(day)
        let start = event.startDate ?? range.lowerBound
        let end = event.endDate ?? start.addingTimeInterval(30 * 60)
        let startMinute = wallMinute(start, in: range)
        let endMinute = wallMinute(end, in: range)
        return (startMinute, max(endMinute - startMinute, Double(Self.minimumMinutes)))
    }

    /// A time's wall-clock minute on the day, 0 before the day and 1440 after it.
    private func wallMinute(_ date: Date, in range: Range<Date>) -> Double {
        if date <= range.lowerBound { return 0 }
        if date >= range.upperBound { return Double(Self.minutesPerDay) }
        let p = calendar.dateComponents([.hour, .minute, .second], from: date)
        return Double((p.hour ?? 0) * 60 + (p.minute ?? 0)) + Double(p.second ?? 0) / 60
    }
}

/// One day's events, ready to draw.
public struct CalendarDayBucket: Sendable, Equatable {
    public var allDay: [CalendarEvent]
    public var laid: [LaidOutEvent]

    public static let empty = CalendarDayBucket(allDay: [], laid: [])

    /// All-day events first, then timed ones by start, for the month cells.
    public var all: [CalendarEvent] { allDay + laid.map(\.event) }
}

/// A timed event and its column among the events it overlaps.
public struct LaidOutEvent: Sendable, Equatable, Identifiable {
    public var event: CalendarEvent
    /// The event's column, from 0.
    public var lane: Int
    /// How many columns its cluster of overlapping events shares.
    public var lanes: Int

    public var id: String { event.id }
}

/// Puts overlapping events side by side. Each event takes the first column
/// free at its start. A cluster is a run of events joined by overlaps, and
/// every event in it gets the same width: one share of the cluster's columns.
/// Expects events sorted by start, as `eventsForDay` returns them.
public func assignLanes(_ events: [CalendarEvent]) -> [LaidOutEvent] {
    var result: [LaidOutEvent] = []
    var cluster: [(event: CalendarEvent, lane: Int, end: Date)] = []
    var clusterEnd = Date.distantPast

    func flush() {
        let lanes = (cluster.map(\.lane).max() ?? -1) + 1
        result += cluster.map { LaidOutEvent(event: $0.event, lane: $0.lane, lanes: lanes) }
        cluster = []
        clusterEnd = .distantPast
    }

    for event in events {
        let start = event.startDate ?? .distantPast
        let end = event.endDate ?? start
        if !cluster.isEmpty && start >= clusterEnd { flush() }
        let taken = Set(cluster.filter { $0.end > start }.map(\.lane))
        var lane = 0
        while taken.contains(lane) { lane += 1 }
        cluster.append((event, lane, end))
        clusterEnd = max(clusterEnd, end)
    }
    if !cluster.isEmpty { flush() }
    return result
}

/// `9 AM`, `12 PM` for the hour axis (0-23).
public func hourLabel(_ hour: Int) -> String {
    let h = (hour + 11) % 12 + 1
    return "\(h) \(hour < 12 ? "AM" : "PM")"
}
