import Foundation

extension YarvisClient {
    public func calendarStatus() async throws -> CalendarStatus {
        try await get(CalendarStatus.self, Self.sidecar("/api/calendar/status"))
    }

    /// The Google consent page to open in the browser.
    public func calendarAuthURL() async throws -> String {
        struct Answer: Decodable { var url: String }
        return try await get(Answer.self, Self.sidecar("/api/calendar/auth-url")).url
    }

    /// Upcoming events, at the sidecar's default count, for the agenda.
    public func upcomingCalendarEvents() async throws -> [CalendarEvent] {
        try await get([CalendarEvent].self, Self.sidecar("/api/calendar/events"))
    }

    /// Events whose start falls within `[from, to)`. The grids need events
    /// from the start of the range, often earlier than now.
    public func calendarEvents(from: Date, to: Date, max: Int = 250) async throws -> [CalendarEvent] {
        let query = "timeMin=\(encodeQueryValue(isoTimestamp(from)))&timeMax=\(encodeQueryValue(isoTimestamp(to)))"
            + "&max=\(max)"
        return try await get([CalendarEvent].self, Self.sidecar("/api/calendar/events?\(query)"))
    }

    public func disconnectCalendar() async throws {
        try await send("POST", Self.sidecar("/api/calendar/disconnect"), body: .object([:]))
    }
}

/// `2026-11-24T05:00:00.000Z`, the shape JavaScript's `toISOString` sends.
func isoTimestamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}
