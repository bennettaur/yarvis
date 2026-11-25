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

private func serverEvent(_ kind: String, _ data: String) throws -> ServerEvent {
    ServerEvent(seq: 1, at: 1, deviceId: nil, kind: kind, data: try JSONDecoder().decode(JSONValue.self, from: json(data)))
}

@Suite struct AlarmEventTests {
    /// What `server/crates/yarvis-server/tests/control_socket.rs` checks the
    /// server sends: no `source`, an integer `fireAtMs`.
    @Test func readsTheServersFirePayload() throws {
        let event = try serverEvent("alarm.fire", """
        {"id":"0f8b5a4e-1c2d-4e3f-9a8b-7c6d5e4f3a2b","label":"Meeting: Standup","fireAtMs":1760000000000,
         "sound":true,"meetLink":"https://meet.google.com/abc","status":"fired"}
        """)
        guard case .alarm(let alarm) = AlarmFire(event) else {
            Issue.record("didn't read the alarm")
            return
        }
        #expect(alarm.id == "0f8b5a4e-1c2d-4e3f-9a8b-7c6d5e4f3a2b")
        #expect(alarm.fireAtMs == 1_760_000_000_000)
        #expect(alarm.source == nil && alarm.isRinging && alarm.meetLink == "https://meet.google.com/abc")
    }

    @Test func aMalformedFireStillNamesItsAlarm() throws {
        #expect(AlarmFire(try serverEvent("alarm.fire", #"{"id":"a","fireAtMs":"soon"}"#)) == .id("a"))
        #expect(AlarmFire(try serverEvent("alarm.fire", #"{"label":"x"}"#)) == .unreadable)
        #expect(AlarmFire(try serverEvent("alarm.fire", "null")) == .unreadable)
    }

    @Test func anUnreadableFireTakesOverOnceListed() {
        var book = AlarmBook()
        book.load([alarm("a", "scheduled", at: 1)])
        book.fired(id: "a")
        #expect(book.takeoverQueue.map(\.id) == ["a"])

        var later = AlarmBook()
        later.fired(id: "b")
        #expect(later.takeoverQueue.isEmpty)
        later.load([alarm("b", "fired", at: 1)])
        #expect(later.takeoverQueue.map(\.id) == ["b"])
    }

    @Test func readsTheReleasedId() throws {
        #expect(releasedAlarmId(try serverEvent("alarm.release", #"{"id":"a"}"#)) == "a")
        #expect(releasedAlarmId(try serverEvent("alarm.release", "{}")) == nil)
    }
}

@Suite struct AlarmRingStateTests {
    @Test func startsEachAlarmOnceAndStopsWhatLeft() {
        var state = AlarmRingState()
        let first = state.sync(queue: [alarm("a", "fired", at: 1)])
        #expect(first.start.map(\.id) == ["a"] && first.stop.isEmpty)
        let again = state.sync(queue: [alarm("a", "fired", at: 1), alarm("b", "fired", at: 2)])
        #expect(again.start.map(\.id) == ["b"])
        let gone = state.sync(queue: [alarm("b", "fired", at: 2)])
        #expect(gone.stop == ["a"] && gone.start.isEmpty)
    }

    @Test func anAnsweredAlarmIsNotRestartedByAStaleList() {
        var state = AlarmRingState()
        state.sync(queue: [alarm("a", "fired", at: 1)])
        let wasSounding = state.answer("a")
        #expect(wasSounding)
        // A list read sent before the answer still says fired.
        let stale = state.sync(queue: [alarm("a", "fired", at: 1)])
        #expect(stale.start.isEmpty && state.sounding.isEmpty)
    }

    @Test func aSnoozedAlarmThatFiresAgainRingsAgain() {
        var state = AlarmRingState()
        state.sync(queue: [alarm("a", "fired", at: 1)])
        state.answer("a")
        // Snoozed: the list drops it from the queue.
        state.sync(queue: [])
        let again = state.sync(queue: [alarm("a", "fired", at: 301)])
        #expect(again.start.map(\.id) == ["a"])
    }

    @Test func aFreshFireRingsEvenBeforeTheListCatchesUp() {
        var state = AlarmRingState()
        state.sync(queue: [alarm("a", "fired", at: 1)])
        state.answer("a")
        state.fired("a")
        let again = state.sync(queue: [alarm("a", "fired", at: 301)])
        #expect(again.start.map(\.id) == ["a"])
    }

    @Test func answeringSomethingNotSoundingSaysSo() {
        var state = AlarmRingState()
        let wasSounding = state.answer("x")
        #expect(!wasSounding)
    }

    @Test func theChimeEscalatesAfterAMinute() {
        #expect(AlarmChime.at(secondsOverdue: 0) == AlarmChime(sound: "Ping", volume: 0.5, gap: 5))
        #expect(AlarmChime.at(secondsOverdue: 59).sound == "Ping")
        let loud = AlarmChime.at(secondsOverdue: alarmEscalationSeconds)
        #expect(loud.sound == "Submarine" && loud.volume == 1 && loud.gap == 2)
    }
}

@Suite struct MeetingArmingTests {
    private let event = CalendarEvent(id: "m", title: "Standup", start: "2030-01-01T09:00:00Z", end: "2030-01-01T09:15:00Z")

    @Test func aSecondRequestWhileOneIsOutIsRefused() {
        var arming = MeetingArming()
        #expect(!arming.isPending(event))
        let first = arming.begin(event)
        #expect(first && arming.isPending(event))
        let second = arming.begin(event)
        #expect(!second)
        arming.end(event)
        #expect(!arming.isPending(event))
        let afterEnd = arming.begin(event)
        #expect(afterEnd)
    }

    @Test func theSameMeetingFromAnotherViewIsTheSameRequest() {
        var arming = MeetingArming()
        _ = arming.begin(event)
        let copy = CalendarEvent(id: "other", title: "Standup", start: "2030-01-01T09:00:00Z", end: "")
        let claimed = arming.begin(copy)
        #expect(!claimed)
    }

    @Test func anEventWithNoStartCantBeClaimed() {
        var arming = MeetingArming()
        let claimed = arming.begin(CalendarEvent(id: "x", title: "x", start: "", end: ""))
        #expect(!claimed)
    }

    @Test func theBookIndexesScheduledMeetingAlarms() {
        var book = AlarmBook()
        let ms = YarvisClient.epochMs(MeetingAlarm.fireAt(event)!)
        book.load([alarm("a", "scheduled", at: ms, label: "Meeting: Standup")])
        #expect(book.meetingAlarms.existing(for: event)?.id == "a")
        book.load([alarm("a", "cancelled", at: ms, label: "Meeting: Standup")])
        #expect(book.meetingAlarms.existing(for: event) == nil)
    }
}
