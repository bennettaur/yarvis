import Foundation
import Testing
@testable import YarvisClient

private func alarm(_ id: String, _ status: String, at ms: Int64, label: String = "x") -> Alarm {
    Alarm(id: id, label: label, fireAtMs: ms, status: status, source: "app")
}

@Suite struct AlarmBookTests {
    @Test func onlyAlarmsThisRunSawFireTakeOver() {
        var book = AlarmBook()
        // Left ringing by an earlier run: listed, but no takeover.
        book.load([alarm("old", "fired", at: 1), alarm("next", "scheduled", at: 9), alarm("soon", "scheduled", at: 5)])
        #expect(book.ringing.map(\.id) == ["old"])
        #expect(book.takeoverQueue.isEmpty)
        #expect(book.scheduled.map(\.id) == ["soon", "next"])

        var payload = alarm("soon", "fired", at: 5)
        payload.source = nil
        let changed = book.fired(payload)
        #expect(changed)
        #expect(book.takeoverQueue.map(\.id) == ["soon"])
        #expect(book.ringing.map(\.id) == ["old", "soon"])
        // The list's `source` survives a payload that has none.
        #expect(book.alarms.first { $0.id == "soon" }?.source == "app")
    }

    @Test func aFireForAnAlarmNotYetListedStillTakesOver() {
        var book = AlarmBook()
        book.fired(alarm("new", "fired", at: 3))
        #expect(book.takeoverQueue.map(\.id) == ["new"])
    }

    @Test func severalAtOnceQueueOldestFirstAndLeaveWhenAnswered() {
        var book = AlarmBook()
        book.fired(alarm("b", "fired", at: 20))
        book.fired(alarm("a", "fired", at: 10))
        #expect(book.takeoverQueue.map(\.id) == ["a", "b"])
        book.load([alarm("a", "acknowledged", at: 10), alarm("b", "fired", at: 20)])
        #expect(book.takeoverQueue.map(\.id) == ["b"])
        #expect(book.firedThisRun == ["b"])
    }

    @Test func aSnoozedAlarmThatRingsAgainTakesOverAgain() {
        var book = AlarmBook()
        book.fired(alarm("a", "fired", at: 10))
        book.load([alarm("a", "snoozed", at: 310)])
        #expect(book.takeoverQueue.isEmpty)
        book.fired(alarm("a", "fired", at: 310))
        #expect(book.takeoverQueue.map(\.fireAtMs) == [310])
    }

    @Test func loadSaysWhetherAnythingChanged() {
        var book = AlarmBook()
        let first = book.load([alarm("a", "scheduled", at: 1)])
        let same = book.load([alarm("a", "scheduled", at: 1)])
        let moved = book.load([alarm("a", "scheduled", at: 2)])
        #expect(first && !same && moved)
    }

    @Test func escalatesAfterAMinute() {
        let a = alarm("a", "fired", at: 1_000_000)
        #expect(secondsOverdue(a, now: Date(timeIntervalSince1970: 999)) == 0)
        #expect(secondsOverdue(a, now: Date(timeIntervalSince1970: 1_059.9)) == 59)
        #expect(secondsOverdue(a, now: Date(timeIntervalSince1970: 1_060)) >= alarmEscalationSeconds)
    }
}

@Suite struct MeetingAlarmTests {
    private let now = Date(timeIntervalSince1970: 1_795_000_000)

    private func meeting(startingIn seconds: TimeInterval, allDay: Bool = false) -> CalendarEvent {
        let formatter = ISO8601DateFormatter()
        let start = formatter.string(from: now.addingTimeInterval(seconds))
        return CalendarEvent(id: "m", title: "Standup", start: allDay ? "2026-11-24" : start, end: start, allDay: allDay)
    }

    @Test func onlyTimedMeetingsThatHaventStartedCanHaveOne() {
        #expect(MeetingAlarm.isArmable(meeting(startingIn: 600), now: now))
        #expect(!MeetingAlarm.isArmable(meeting(startingIn: -60), now: now))
        #expect(!MeetingAlarm.isArmable(meeting(startingIn: 600, allDay: true), now: now))
    }

    @Test func ringsAMinuteEarlyUnderTheSidecarsLabel() {
        let event = meeting(startingIn: 600)
        #expect(MeetingAlarm.label(event) == "Meeting: Standup")
        #expect(MeetingAlarm.fireAt(event) == now.addingTimeInterval(540))
    }

    @Test func findsAnAlarmAlreadySetWithinTheTolerance() {
        let event = meeting(startingIn: 600)
        let fireMs = YarvisClient.epochMs(now.addingTimeInterval(540))
        let set = alarm("a", "scheduled", at: fireMs + 60_000, label: "Meeting: Standup")
        #expect(MeetingAlarm.existing(for: event, in: [set])?.id == "a")
        let tooFar = alarm("b", "scheduled", at: fireMs + 90_000, label: "Meeting: Standup")
        #expect(MeetingAlarm.existing(for: event, in: [tooFar]) == nil)
        let otherLabel = alarm("c", "scheduled", at: fireMs, label: "Standup")
        #expect(MeetingAlarm.existing(for: event, in: [otherLabel]) == nil)
        let done = alarm("d", "acknowledged", at: fireMs, label: "Meeting: Standup")
        #expect(MeetingAlarm.existing(for: event, in: [done]) == nil)
    }
}

private func client(_ status: Int = 200, _ body: String) -> (YarvisClient, String) {
    let (session, id) = StubProtocol.session { _, _ in (status, json(body)) }
    return (YarvisClient(baseURL: base, token: "tok", session: session), id)
}

@Suite struct AlarmsAPITests {
    @Test func listsAlarmsWithOptionalFields() async throws {
        let (c, id) = client(200, """
        [{"id":"a","label":"Standup","fireAtMs":1795000000000,"sound":true,"meetLink":null,"status":"scheduled","source":"chat"},
         {"id":"b","label":"Tea","fireAtMs":1.7950006e12,"sound":false,"meetLink":"https://meet.google.com/x","status":"fired"}]
        """)
        let list = try await c.alarms()
        #expect(list.map(\.fireAtMs) == [1_795_000_000_000, 1_795_000_600_000])
        #expect(list[0].source == "chat" && list[1].source == nil)
        #expect(list[1].isRinging && !list[1].sound)
        #expect(StubProtocol.recorded(id).first?.0.url?.path == "/api/sidecar/api/alarms")
    }

    @Test func createsWithWholeMilliseconds() async throws {
        let (c, id) = client(201, #"{"id":"a","label":"Meeting: X","fireAtMs":1795000000123,"sound":true,"meetLink":"https://m","status":"scheduled","source":"app"}"#)
        try await c.createAlarm(label: "Meeting: X", fireAt: Date(timeIntervalSince1970: 1_795_000_000.123), meetLink: "https://m")
        let (req, body) = try #require(StubProtocol.recorded(id).first)
        #expect(req.httpMethod == "POST")
        let sent = String(decoding: try #require(body), as: UTF8.self)
        #expect(sent.contains("\"fireAtMs\":1795000000123"))
        #expect(bodyJSON(body)?["meetLink"]?.stringValue == "https://m")
        #expect(bodyJSON(body)?["sound"] == .bool(true))
    }

    @Test func actionsPostToTheAlarmsRoutes() async throws {
        let (c, id) = client(200, "{}")
        try await c.acknowledgeAlarm(id: "a")
        try await c.cancelAlarm(id: "a")
        try await c.snoozeAlarm(id: "a", minutes: 5)
        let reqs = StubProtocol.recorded(id)
        #expect(reqs.map { $0.0.url?.path ?? "" } == [
            "/api/sidecar/api/alarms/a/acknowledge",
            "/api/sidecar/api/alarms/a/cancel",
            "/api/sidecar/api/alarms/a/snooze",
        ])
        #expect(reqs.allSatisfy { $0.0.httpMethod == "POST" })
        #expect(bodyJSON(reqs[2].1)?["minutes"] == .number(5))
    }

    @Test func aMissingAlarmIsAnError() async throws {
        let (c, _) = client(404, #"{"error":"no alarm with that id"}"#)
        await #expect(throws: YarvisError.http(status: 404, error: "no alarm with that id", detail: nil)) {
            try await c.acknowledgeAlarm(id: "gone")
        }
    }

    @Test func streamEventsAreChangedOrNot() throws {
        #expect(try AlarmStreamEvent.decode(json(#"{"type":"changed"}"#)) == .changed)
        #expect(try AlarmStreamEvent.decode(json(#"{"type":"ping"}"#)) == .other)
    }

    @Test func recordsAUserMadeAlarm() async throws {
        let (c, id) = client(200, "{}")
        try await c.recordAlarmCreated(label: "Standup", fireAt: Date(timeIntervalSince1970: 1_795_000_000))
        let (req, body) = try #require(StubProtocol.recorded(id).first)
        #expect(req.url?.path == "/api/sidecar/api/events")
        #expect(bodyJSON(body)?["type"]?.stringValue == "alarm.created")
        #expect(bodyJSON(body)?["payload"]?["fireAt"]?.stringValue == "2026-11-18T11:06:40.000Z")
    }
}
