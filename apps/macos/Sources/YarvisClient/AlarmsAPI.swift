import Foundation

extension YarvisClient {
    private static func alarmPath(_ rest: String = "") -> String { sidecar("/api/alarms\(rest)") }

    public func alarms() async throws -> [Alarm] {
        try await get([Alarm].self, Self.alarmPath())
    }

    @discardableResult
    public func createAlarm(label: String, fireAt: Date, sound: Bool = true, meetLink: String? = nil) async throws -> Alarm {
        try await post(Alarm.self, Self.alarmPath(), body: .object([
            "label": .string(label),
            "fireAtMs": .number(Double(Self.epochMs(fireAt))),
            "sound": .bool(sound),
            "meetLink": meetLink.map(JSONValue.string) ?? .null,
        ]))
    }

    public func acknowledgeAlarm(id: String) async throws {
        try await send("POST", Self.alarmPath("/\(encodePathSegment(id))/acknowledge"), body: .object([:]))
    }

    public func cancelAlarm(id: String) async throws {
        try await send("POST", Self.alarmPath("/\(encodePathSegment(id))/cancel"), body: .object([:]))
    }

    public func snoozeAlarm(id: String, minutes: Int) async throws {
        try await send("POST", Self.alarmPath("/\(encodePathSegment(id))/snooze"),
                       body: .object(["minutes": .number(Double(minutes))]))
    }

    /// Says when the list changed on the sidecar. Forward only: read the list
    /// again after it drops.
    public func alarmStream() throws -> AsyncThrowingStream<AlarmStreamEvent, Error> {
        decodedEventStream(try request("GET", Self.alarmPath("/stream")), AlarmStreamEvent.decode)
    }

    /// Logs a user-made alarm to the event log, which the memory jobs read.
    /// Calendar arming and test alarms aren't logged.
    public func recordAlarmCreated(label: String, fireAt: Date) async throws {
        try await send("POST", Self.sidecar("/api/events"), body: .object([
            "type": .string("alarm.created"),
            "payload": .object(["label": .string(label), "fireAt": .string(isoTimestamp(fireAt))]),
            "source": .string("alarms"),
        ]))
    }

    static func epochMs(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded()) }
}
