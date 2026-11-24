import Foundation

// MARK: - Calendar (sidecar `google/routes.ts`)

/// Whether Google Calendar is set up (`GET /api/calendar/status`).
public struct CalendarStatus: Decodable, Sendable, Equatable {
    /// The OAuth client id and secret are in Settings.
    public var configured: Bool
    /// A token is stored.
    public var connected: Bool

    public init(configured: Bool, connected: Bool) {
        self.configured = configured
        self.connected = connected
    }
}

/// One Google Calendar event. Timed events carry ISO timestamps with an
/// offset; all-day events carry date-only strings with an exclusive end.
public struct CalendarEvent: Decodable, Sendable, Identifiable, Hashable {
    public var id: String
    public var title: String
    public var start: String
    public var end: String
    public var allDay: Bool
    public var meetLink: String?

    /// `start` and `end` read once here, since the grids ask for them often.
    public private(set) var startDate: Date?
    public private(set) var endDate: Date?

    enum CodingKeys: String, CodingKey {
        case id, title, start, end, allDay, meetLink
    }

    public init(id: String, title: String, start: String, end: String, allDay: Bool = false, meetLink: String? = nil) {
        self.id = id
        self.title = title
        self.start = start
        self.end = end
        self.allDay = allDay
        self.meetLink = meetLink
        startDate = parseEventTime(start)
        endDate = parseEventTime(end)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(String.self, forKey: .id),
            title: try c.decodeIfPresent(String.self, forKey: .title) ?? "",
            start: try c.decodeIfPresent(String.self, forKey: .start) ?? "",
            end: try c.decodeIfPresent(String.self, forKey: .end) ?? "",
            allDay: try c.decodeIfPresent(Bool.self, forKey: .allDay) ?? false,
            meetLink: try c.decodeIfPresent(String.self, forKey: .meetLink)
        )
    }
}

/// Reads an event time: an ISO timestamp, or a bare date, which counts as
/// UTC midnight.
func parseEventTime(_ s: String) -> Date? {
    if let date = parseISODate(s) { return date }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withFullDate]
    return formatter.date(from: s)
}

// MARK: - Alarms (sidecar `alarms/routes.ts`)

/// An alarm the sidecar keeps. It decides when one is due; the server then
/// sends `alarm.fire` on the event stream for each client to ring.
public struct Alarm: Codable, Sendable, Identifiable, Equatable, Hashable {
    public var id: String
    public var label: String
    /// When it rings, in ms since the epoch.
    public var fireAtMs: Int64
    public var sound: Bool
    /// The join link of a meeting alarm.
    public var meetLink: String?
    /// `scheduled`, `fired`, `acknowledged`, `snoozed` or `cancelled`.
    public var status: String
    /// Who set it: `app`, `chat` or `heads-down`. Missing on `alarm.fire`.
    public var source: String?

    public init(id: String, label: String, fireAtMs: Int64, sound: Bool = true, meetLink: String? = nil,
                status: String, source: String? = nil) {
        self.id = id
        self.label = label
        self.fireAtMs = fireAtMs
        self.sound = sound
        self.meetLink = meetLink
        self.status = status
        self.source = source
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        // A JSON number may arrive as a double, such as `1.76e12`.
        if let ms = try? c.decode(Int64.self, forKey: .fireAtMs) {
            fireAtMs = ms
        } else {
            fireAtMs = Int64(try c.decode(Double.self, forKey: .fireAtMs))
        }
        sound = try c.decodeIfPresent(Bool.self, forKey: .sound) ?? true
        meetLink = try c.decodeIfPresent(String.self, forKey: .meetLink)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "scheduled"
        source = try c.decodeIfPresent(String.self, forKey: .source)
    }

    public var fireAt: Date { Date(timeIntervalSince1970: Double(fireAtMs) / 1000) }
    public var isScheduled: Bool { status == "scheduled" }
    public var isRinging: Bool { status == "fired" }
}

/// One message on `/api/alarms/stream`. Only `changed` matters; the rest are
/// keep-alives.
public enum AlarmStreamEvent: Sendable, Equatable {
    case changed
    case other

    static func decode(_ data: Data) throws -> AlarmStreamEvent {
        struct Raw: Decodable { var type: String? }
        return try JSONDecoder().decode(Raw.self, from: data).type == "changed" ? .changed : .other
    }
}
