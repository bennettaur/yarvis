import Foundation
import Testing
@testable import YarvisClient

/// Toronto, which changes clocks: 2026-03-08 is 23 hours long and 2026-11-01 is 25.
private let toronto: CalendarGrid = {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "America/Toronto")!
    return CalendarGrid(calendar: cal)
}()

private func local(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 0, _ min: Int = 0) -> Date {
    toronto.calendar.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
}

private func timed(_ id: String, _ start: String, _ end: String) -> CalendarEvent {
    CalendarEvent(id: id, title: id, start: start, end: end)
}

@Suite struct CalendarGridTests {
    @Test func readsOffsetsZuluFractionsAndBareDates() {
        #expect(parseEventTime("2026-11-24T09:00:00-05:00") == local(2026, 11, 24, 9))
        #expect(parseEventTime("2026-11-24T14:00:00Z") == local(2026, 11, 24, 9))
        #expect(parseEventTime("2026-11-24T14:00:00.500Z") == local(2026, 11, 24, 9).addingTimeInterval(0.5))
        #expect(parseEventTime("2026-11-24") == Date(timeIntervalSince1970: 1_795_478_400))
        #expect(parseEventTime("") == nil)
        #expect(parseEventTime("soon") == nil)
    }

    @Test func weeksStartOnSundayWhateverTheLocale() {
        var cal = toronto.calendar
        cal.firstWeekday = 2
        let grid = CalendarGrid(calendar: cal)
        // Tuesday.
        let days = grid.weekDays(local(2026, 11, 24, 15))
        #expect(days.first == local(2026, 11, 22))
        #expect(days.last == local(2026, 11, 28))
        #expect(grid.weekRange(local(2026, 11, 22)) == local(2026, 11, 22)..<local(2026, 11, 29))
    }

    @Test func theMonthGridIsSixWholeWeeks() {
        let days = toronto.monthGridDays(local(2026, 11, 24))
        #expect(days.count == 42)
        // November 2026 starts on a Sunday.
        #expect(days.first == local(2026, 11, 1))
        #expect(days.last == local(2026, 12, 12))
        let feb = toronto.monthGridDays(local(2026, 2, 10))
        #expect(feb.first == local(2026, 2, 1))
        let march = toronto.monthRange(local(2026, 3, 31))
        #expect(march.lowerBound == local(2026, 3, 1))
        #expect(march.upperBound == local(2026, 4, 12))
        #expect(toronto.addMonths(local(2026, 1, 31), 1) == local(2026, 2, 1))
        #expect(toronto.addMonths(local(2026, 1, 15), -1) == local(2025, 12, 1))
    }

    @Test func daysFollowClockChanges() {
        let spring = toronto.dayRange(local(2026, 3, 8, 12))
        #expect(spring.upperBound.timeIntervalSince(spring.lowerBound) == 23 * 3600)
        let fall = toronto.dayRange(local(2026, 11, 1, 12))
        #expect(fall.upperBound.timeIntervalSince(fall.lowerBound) == 25 * 3600)
        // Every cell of a month with a clock change is still a midnight.
        for day in toronto.monthGridDays(local(2026, 3, 1)) {
            #expect(toronto.minutesIntoDay(day) == 0)
        }
        #expect(toronto.dayKey(local(2026, 3, 8, 23, 30)) == "2026-03-08")
    }

    @Test func splitsAllDayAndTimedEventsForADay() {
        let day = local(2026, 11, 24)
        let events = [
            timed("late", "2026-11-24T15:00:00-05:00", "2026-11-24T16:00:00-05:00"),
            timed("early", "2026-11-24T09:00:00-05:00", "2026-11-24T10:00:00-05:00"),
            timed("overnight", "2026-11-23T23:00:00-05:00", "2026-11-24T01:00:00-05:00"),
            timed("endsAtMidnight", "2026-11-23T22:00:00-05:00", "2026-11-24T00:00:00-05:00"),
            timed("tomorrow", "2026-11-25T00:00:00-05:00", "2026-11-25T01:00:00-05:00"),
            timed("instant", "2026-11-24T00:00:00-05:00", "2026-11-24T00:00:00-05:00"),
            CalendarEvent(id: "trip", title: "trip", start: "2026-11-23", end: "2026-11-25", allDay: true),
            CalendarEvent(id: "yesterday", title: "y", start: "2026-11-23", end: "2026-11-24", allDay: true),
        ]
        let split = toronto.eventsForDay(events, day: day)
        #expect(split.allDay.map(\.id) == ["trip"])
        #expect(split.timed.map(\.id) == ["overnight", "instant", "early", "late"])
    }

    @Test func allDayDatesAreNotShiftedByTheTimeZone() {
        var tokyo = Calendar(identifier: .gregorian)
        tokyo.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let grid = CalendarGrid(calendar: tokyo)
        let holiday = CalendarEvent(id: "h", title: "h", start: "2026-11-24", end: "2026-11-25", allDay: true)
        let day = tokyo.date(from: DateComponents(year: 2026, month: 11, day: 24))!
        #expect(grid.eventsForDay([holiday], day: day).allDay.count == 1)
        #expect(grid.startDay(holiday) == day)
    }

    @Test func groupsTheAgendaByStartDay() {
        let events = [
            timed("b", "2026-11-25T09:00:00-05:00", "2026-11-25T10:00:00-05:00"),
            timed("a", "2026-11-24T23:30:00-05:00", "2026-11-25T00:30:00-05:00"),
            CalendarEvent(id: "c", title: "c", start: "2026-11-25", end: "2026-11-26", allDay: true),
            timed("broken", "", ""),
        ]
        let groups = toronto.groupByDay(events)
        #expect(groups.map(\.day) == [local(2026, 11, 24), local(2026, 11, 25)])
        #expect(groups.map { $0.events.map(\.id) } == [["a"], ["b", "c"]])
    }

    @Test func placesEventsOnTheDayAndClampsToIt() {
        let day = local(2026, 11, 24)
        let p = toronto.placement(timed("x", "2026-11-24T09:30:00-05:00", "2026-11-24T11:00:00-05:00"), day: day)
        #expect(p.startMinute == 570 && p.minutes == 90)
        let overnight = toronto.placement(timed("o", "2026-11-23T23:00:00-05:00", "2026-11-24T01:00:00-05:00"), day: day)
        #expect(overnight.startMinute == 0 && overnight.minutes == 60)
        let tiny = toronto.placement(timed("t", "2026-11-24T12:00:00-05:00", "2026-11-24T12:05:00-05:00"), day: day)
        #expect(tiny.minutes == 15)
        let noEnd = toronto.placement(timed("n", "2026-11-24T12:00:00-05:00", ""), day: day)
        #expect(noEnd.minutes == 30)
        let late = toronto.placement(timed("l", "2026-11-24T23:00:00-05:00", "2026-11-25T02:00:00-05:00"), day: day)
        #expect(late.startMinute == 1380 && late.minutes == 60)
        // The 25-hour day runs to minute 1500.
        let fallDay = local(2026, 11, 1)
        let all = toronto.placement(timed("f", "2026-11-01T00:00:00-04:00", "2026-11-02T00:00:00-05:00"), day: fallDay)
        #expect(all.minutes == 1500)
    }

    @Test func overlappingEventsShareColumns() {
        let laid = assignLanes([
            timed("a", "2026-11-24T09:00:00Z", "2026-11-24T10:00:00Z"),
            timed("b", "2026-11-24T09:30:00Z", "2026-11-24T10:30:00Z"),
            timed("c", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z"),
            timed("d", "2026-11-24T11:00:00Z", "2026-11-24T12:00:00Z"),
        ])
        let lanes = Dictionary(uniqueKeysWithValues: laid.map { ($0.id, [$0.lane, $0.lanes]) })
        // a, b and c chain into one cluster; c reuses a's column once a ends.
        #expect(lanes["a"] == [0, 2])
        #expect(lanes["b"] == [1, 2])
        #expect(lanes["c"] == [0, 2])
        // d starts as the cluster ends, so it gets the full width.
        #expect(lanes["d"] == [0, 1])
        #expect(assignLanes([]).isEmpty)
    }

    @Test func threeAtOnceGetThreeColumns() {
        let laid = assignLanes([
            timed("a", "2026-11-24T09:00:00Z", "2026-11-24T12:00:00Z"),
            timed("b", "2026-11-24T09:00:00Z", "2026-11-24T10:00:00Z"),
            timed("c", "2026-11-24T09:15:00Z", "2026-11-24T09:45:00Z"),
            timed("d", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z"),
        ])
        #expect(laid.map(\.lane) == [0, 1, 2, 1])
        #expect(Set(laid.map(\.lanes)) == [3])
    }

    @Test func hourLabels() {
        #expect(hourLabel(1) == "1 AM")
        #expect(hourLabel(9) == "9 AM")
        #expect(hourLabel(12) == "12 PM")
        #expect(hourLabel(13) == "1 PM")
        #expect(hourLabel(23) == "11 PM")
    }
}

private func client(_ status: Int = 200, _ body: String) -> (YarvisClient, String) {
    let (session, id) = StubProtocol.session { _, _ in (status, json(body)) }
    return (YarvisClient(baseURL: base, token: "tok", session: session), id)
}

@Suite struct CalendarAPITests {
    @Test func readsStatusAndEvents() async throws {
        let (c, _) = client(200, #"{"configured":true,"connected":false,"scope":null,"canCreateEvents":false}"#)
        #expect(try await c.calendarStatus() == CalendarStatus(configured: true, connected: false))

        let (e, id) = client(200, """
        [{"id":"1","title":"Standup","start":"2026-11-24T09:00:00-05:00","end":"2026-11-24T09:15:00-05:00",
          "allDay":false,"location":null,"meetLink":"https://meet.google.com/x","htmlLink":null,
          "response":"accepted","optional":false,"attachments":[]}]
        """)
        let events = try await e.upcomingCalendarEvents()
        #expect(events.first?.meetLink == "https://meet.google.com/x")
        #expect(events.first?.startDate == local(2026, 11, 24, 9))
        let (req, _) = try #require(StubProtocol.recorded(id).first)
        #expect(req.url?.path == "/api/sidecar/api/calendar/events")
    }

    @Test func asksForARangeInUTC() async throws {
        let (c, id) = client(200, "[]")
        _ = try await c.calendarEvents(from: local(2026, 11, 22), to: local(2026, 11, 29))
        let (req, _) = try #require(StubProtocol.recorded(id).first)
        let items = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        #expect(query["timeMin"] == "2026-11-22T05:00:00.000Z")
        #expect(query["timeMax"] == "2026-11-29T05:00:00.000Z")
        #expect(query["max"] == "250")
    }

    @Test func disconnectPostsAndAuthURLIsRead() async throws {
        let (c, id) = client(200, #"{"url":"https://accounts.google.com/o/oauth2"}"#)
        #expect(try await c.calendarAuthURL() == "https://accounts.google.com/o/oauth2")
        try await c.disconnectCalendar()
        let reqs = StubProtocol.recorded(id)
        #expect(reqs.last?.0.httpMethod == "POST")
        #expect(reqs.last?.0.url?.path == "/api/sidecar/api/calendar/disconnect")
    }
}
