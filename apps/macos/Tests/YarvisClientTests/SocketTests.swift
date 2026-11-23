import Foundation
import Testing
@testable import YarvisClient

@Suite struct CloseCodeTests {
    @Test func eachCloseCodeHasOneAction() {
        #expect(closeAction(for: 4401) == .signOut)
        #expect(closeAction(for: 4403) == .stop)
        #expect(closeAction(for: 4400) == .stop)
        #expect(closeAction(for: 1011) == .retry)
        #expect(closeAction(for: 1000) == .retry)
    }

    @Test func backoffDoublesToItsCapAndResets() {
        var b = Backoff(min: .seconds(1), max: .seconds(5))
        #expect([b.take(), b.take(), b.take(), b.take()] == [.seconds(1), .seconds(2), .seconds(4), .seconds(5)])
        b.reset()
        #expect(b.take() == .seconds(1))
    }
}

@Suite(.timeLimit(.minutes(1))) struct EventStreamTests {
    @Test func authenticatesFirstAndResumesWithSinceAfterADrop() async throws {
        let first = FakeSocket([.message(eventText(seq: 5)), .message(eventText(seq: 6)), .close(1011)])
        // The second connection replays 6, which must not be delivered twice.
        let second = FakeSocket([.message(eventText(seq: 6)), .message(eventText(seq: 7)), .close(4401)])
        let opener = FakeOpener([first, second])
        let sleeper = RecordingSleeper()
        let stream = EventStream(baseURL: base, token: "tok", opener: opener, sleep: sleeper.sleeper)
        await stream.start()
        let updates = await collect(stream.updates)

        let seqs = updates.compactMap { if case .event(let e) = $0 { return e.seq } else { return nil } }
        #expect(seqs == [5, 6, 7])
        #expect(updates.last == .signedOut)
        #expect(updates.contains(.disconnected(retryIn: .seconds(1))))
        #expect(opener.urls.first?.absoluteString == "wss://yarvis.example.ts.net/api/events")
        #expect(first.hello == .object(["type": .string("auth"), "token": .string("tok")]))
        #expect(second.hello?["since"] == .number(6))
        #expect(sleeper.waits == [.seconds(1)])
        #expect(opener.urls.count == 2)
    }

    @Test func startsFromAGivenSeq() async throws {
        let socket = FakeSocket([.close(4401)])
        let stream = EventStream(baseURL: base, token: "t", since: 41, opener: FakeOpener([socket]),
                                 sleep: RecordingSleeper().sleeper)
        await stream.start()
        _ = await collect(stream.updates)
        #expect(socket.hello?["since"] == .number(41))
    }

    @Test func laggedReloadsAndReconnectsFromNow() async throws {
        let first = FakeSocket([.message(eventText(seq: 9)), .message(.text(#"{"type":"lagged"}"#))])
        let second = FakeSocket([.close(4403)])
        let opener = FakeOpener([first, second])
        let sleeper = RecordingSleeper()
        let stream = EventStream(baseURL: base, token: "tok", opener: opener, sleep: sleeper.sleeper)
        await stream.start()
        let updates = await collect(stream.updates)

        #expect(updates.contains(.lagged))
        #expect(updates.last == .refused(code: 4403))
        #expect(first.closed)
        #expect(second.hello?["since"] == nil)
        // A lagged reconnect is immediate; there's nothing to back off from.
        #expect(sleeper.waits.isEmpty)
        #expect(opener.urls.count == 2)
    }

    @Test func backsOffLongerOnEachFailureUntilAnEventArrives() async throws {
        let sockets = [
            FakeSocket([.close(1011)]),
            FakeSocket([]),
            FakeSocket([.message(eventText(seq: 1)), .close(1011)]),
            FakeSocket([.close(4400)]),
        ]
        let sleeper = RecordingSleeper()
        let opener = FakeOpener(sockets)
        let stream = EventStream(baseURL: base, token: "t", opener: opener, sleep: sleeper.sleeper)
        await stream.start()
        let updates = await collect(stream.updates)

        #expect(sleeper.waits == [.seconds(1), .seconds(2), .seconds(1)])
        #expect(opener.urls.count == 4)
        #expect(updates.last == .refused(code: 4400))
    }
}

@Suite struct PtyFramingTests {
    @Test func framesCarryABigEndianOffset() throws {
        let frame = PtyFrame(offset: 0x0102_0304_0506_0708, bytes: Data("hi".utf8))
        #expect(Array(frame.encoded) == [1, 2, 3, 4, 5, 6, 7, 8, 0x68, 0x69])
        #expect(PtyFrame(frame.encoded) == frame)
        #expect(PtyFrame(Data([0, 0, 0])) == nil)
    }

    @Test func parsesEveryServerMessage() {
        let attached = PtyServerMessage.decode(#"{"type":"attached","clientId":7,"mode":"resume","requestedOffset":1234,"startOffset":1234,"endOffset":1500,"lostBytes":0,"cols":120,"rows":32,"owner":7,"exit":null}"#)
        #expect(attached == .attached(PtyAttach(clientId: 7, mode: "resume", startOffset: 1234, endOffset: 1500,
                                                lostBytes: 0, cols: 120, rows: 32, owner: 7)))
        #expect(PtyServerMessage.decode(#"{"type":"size","cols":100,"rows":30,"owner":null}"#) == .size(cols: 100, rows: 30, owner: nil))
        #expect(PtyServerMessage.decode(#"{"type":"exit","code":3}"#) == .exit(code: 3))
        #expect(PtyServerMessage.decode(#"{"type":"error","error":"session cap"}"#) == .error("session cap"))
        #expect(PtyServerMessage.decode("not json") == .unknown)
    }

    @Test func aSnapshotResetsTheScreenAndOverlapIsTrimmed() {
        var s = PtyStreamState()
        s.header(PtyAttach(mode: "snapshot", startOffset: 100, endOffset: 110))
        let first = s.accept(PtyFrame(offset: 100, bytes: Data("0123456789".utf8)))
        #expect(first.reset)
        #expect(s.nextOffset == 110)
        // A frame that starts before the last byte fed only adds what's new.
        let overlap = s.accept(PtyFrame(offset: 105, bytes: Data("56789AB".utf8)))
        #expect(!overlap.reset)
        #expect(String(decoding: overlap.bytes, as: UTF8.self) == "AB")
        #expect(s.nextOffset == 112)
        let stale = s.accept(PtyFrame(offset: 100, bytes: Data("01".utf8)))
        #expect(stale.bytes.isEmpty)
        #expect(s.nextOffset == 112)
    }

    @Test func aResumeAppends() {
        var s = PtyStreamState()
        s.header(PtyAttach(mode: "resume", startOffset: 0, endOffset: 3))
        #expect(s.accept(PtyFrame(offset: 0, bytes: Data("abc".utf8))) == (false, Data("abc".utf8)))
    }
}

private func attached(_ mode: String, start: UInt64, end: UInt64) -> FakeSocket.Step {
    .message(.text(#"{"type":"attached","clientId":1,"mode":"\#(mode)","startOffset":\#(start),"endOffset":\#(end),"lostBytes":0,"cols":80,"rows":24,"owner":1}"#))
}

private func output(_ offset: UInt64, _ s: String) -> FakeSocket.Step {
    .message(.data(PtyFrame(offset: offset, bytes: Data(s.utf8)).encoded))
}

@Suite(.timeLimit(.minutes(1))) struct PtyConnectionTests {
    @Test func resumesFromTheLastByteAfterADrop() async throws {
        let first = FakeSocket([attached("snapshot", start: 0, end: 5), output(0, "hello"), output(5, " wor")])
        let second = FakeSocket([
            attached("resume", start: 9, end: 11), output(9, "ld"),
            .message(.text(#"{"type":"exit","code":0}"#)), .close(1000),
        ])
        let opener = FakeOpener([first, second])
        let pty = PtyConnection(baseURL: base, token: "tok", sessionId: "tab:terminal/t1/p1", cols: 100, rows: 40,
                                cwd: "/tmp", opener: opener, sleep: RecordingSleeper().sleeper)
        await pty.start()
        let updates = await collect(pty.updates)

        let text = updates.compactMap { if case .output(let d) = $0 { return String(decoding: d, as: UTF8.self) } else { return nil } }
        #expect(text.joined() == "hello world")
        #expect(updates.first == .reset)
        #expect(updates.filter { $0 == .reset }.count == 1)
        #expect(updates.contains(.reconnecting))
        #expect(updates.last == .exit(code: 0))
        #expect(opener.urls.count == 2)
        #expect(opener.urls[0].absoluteString == "wss://yarvis.example.ts.net/api/pty/tab:terminal%2Ft1%2Fp1")
        #expect(first.hello == .object([
            "type": .string("auth"), "token": .string("tok"),
            "cols": .number(100), "rows": .number(40), "cwd": .string("/tmp"),
        ]))
        #expect(second.hello?["offset"] == .number(9))
    }

    @Test func aSnapshotOnReconnectResetsTheScreenAgain() async throws {
        let first = FakeSocket([attached("snapshot", start: 0, end: 3), output(0, "old")])
        // The server lost offset 3, so it sends what it kept instead.
        let second = FakeSocket([
            attached("snapshot", start: 50, end: 53), output(50, "new"),
            .message(.text(#"{"type":"exit","code":null}"#)), .close(1000),
        ])
        let pty = PtyConnection(baseURL: base, token: "t", sessionId: "x", cols: 80, rows: 24,
                                opener: FakeOpener([first, second]), sleep: RecordingSleeper().sleeper)
        await pty.start()
        let updates = await collect(pty.updates)
        #expect(updates == [.reset, .output(Data("old".utf8)), .reconnecting, .reset, .output(Data("new".utf8)),
                            .exit(code: nil)])
        #expect(second.hello?["offset"] == .number(3))
    }

    @Test func aResyncMidStreamReplacesTheScreen() async throws {
        let socket = FakeSocket([
            attached("resume", start: 0, end: 2), output(0, "ab"),
            .message(.text(#"{"type":"resync","clientId":1,"mode":"snapshot","startOffset":90,"endOffset":92,"lostBytes":88,"cols":80,"rows":24,"owner":1}"#)),
            output(90, "yz"), .message(.text(#"{"type":"exit","code":0}"#)), .close(1000),
        ])
        let pty = PtyConnection(baseURL: base, token: "t", sessionId: "x", cols: 80, rows: 24,
                                opener: FakeOpener([socket]), sleep: RecordingSleeper().sleeper)
        await pty.start()
        #expect(await collect(pty.updates) == [.output(Data("ab".utf8)), .reset, .output(Data("yz".utf8)), .exit(code: 0)])
    }

    @Test func anAgentThatStoppedIsNotReattached() async throws {
        let opener = FakeOpener([FakeSocket([attached("snapshot", start: 0, end: 2), output(0, "hi")])])
        let pty = PtyConnection(baseURL: base, token: "t", sessionId: "ws-claude:w1", cols: 80, rows: 24,
                                mayReconnect: { false }, opener: opener, sleep: RecordingSleeper().sleeper)
        await pty.start()
        let updates = await collect(pty.updates)
        #expect(updates == [.reset, .output(Data("hi".utf8)), .reconnecting, .refused(code: 1000)])
        #expect(opener.urls.count == 1)
    }

    @Test func aRefusalEndsTheConnection() async throws {
        let socket = FakeSocket([.message(.text(#"{"type":"error","error":"too many sessions"}"#)), .close(4400)])
        let pty = PtyConnection(baseURL: base, token: "t", sessionId: "x", cols: 80, rows: 24,
                                opener: FakeOpener([socket]), sleep: RecordingSleeper().sleeper)
        await pty.start()
        let updates = await collect(pty.updates)
        #expect(updates == [.error("too many sessions"), .refused(code: 4400)])
    }

    @Test func a4401SignsOut() async throws {
        let pty = PtyConnection(baseURL: base, token: "t", sessionId: "x", cols: 80, rows: 24,
                                opener: FakeOpener([FakeSocket([.close(4401)])]), sleep: RecordingSleeper().sleeper)
        await pty.start()
        #expect(await collect(pty.updates) == [.signedOut])
    }
}

@Suite struct PtyInputTests {
    /// A socket that stays open, so the connection holds it while the test types.
    final class OpenSocket: WebSocketConnection, @unchecked Sendable {
        private let lock = NSLock()
        private var _sent: [WebSocketMessage] = []
        private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []

        var sent: [WebSocketMessage] { lock.withLock { _sent } }

        /// Returns once `count` messages have been sent.
        func waitForSends(_ count: Int) async {
            await withCheckedContinuation { c in
                let done = lock.withLock { () -> Bool in
                    if _sent.count >= count { return true }
                    waiters.append((count, c))
                    return false
                }
                if done { c.resume() }
            }
        }

        func send(_ m: WebSocketMessage) async throws {
            let ready = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
                _sent.append(m)
                let (met, rest) = (waiters.filter { $0.0 <= _sent.count }, waiters.filter { $0.0 > _sent.count })
                waiters = rest
                return met.map(\.1)
            }
            ready.forEach { $0.resume() }
        }

        func receive() async throws -> WebSocketMessage {
            try await Task.sleep(for: .seconds(3600))
            throw CancellationError()
        }

        func close() {}
    }

    struct Opener: WebSocketOpener {
        let socket: OpenSocket
        func open(_ url: URL) -> any WebSocketConnection { socket }
    }

    @Test(.timeLimit(.minutes(1))) func splitsLargeInputAndSendsResizeAndFocus() async throws {
        let socket = OpenSocket()
        let pty = PtyConnection(baseURL: base, token: "t", sessionId: "x", cols: 80, rows: 24,
                                opener: Opener(socket: socket), sleep: realSleep)
        await pty.start()
        // The connection holds the socket once its hello is sent.
        await socket.waitForSends(1)
        await pty.send(input: Data(repeating: 0x61, count: 64 * 1024 * 2 + 10))
        await pty.resize(cols: 120, rows: 30)
        await pty.focus()
        // hello, three input chunks, resize, focus
        await socket.waitForSends(6)
        await pty.stop()

        let sent = socket.sent
        let sizes = sent.compactMap { if case .data(let d) = $0 { return d.count } else { return nil } }
        #expect(sizes == [65536, 65536, 10])
        guard case .text(let resize) = sent[4] else {
            Issue.record("no resize message")
            return
        }
        #expect(try JSONDecoder().decode(JSONValue.self, from: Data(resize.utf8))
            == .object(["type": .string("resize"), "cols": .number(120), "rows": .number(30)]))
        #expect(sent[5] == .text(#"{"type":"focus"}"#))
    }
}
