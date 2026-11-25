import Foundation

// The PTY attach protocol (`/api/pty/{id}`), as `pty/ws.rs` and
// `docs/client-server.md` describe it.

/// One binary output frame: an 8-byte big-endian stream offset, then bytes.
public struct PtyFrame: Equatable, Sendable {
    public var offset: UInt64
    public var bytes: Data

    public init(offset: UInt64, bytes: Data) {
        self.offset = offset
        self.bytes = bytes
    }

    public init?(_ data: Data) {
        guard data.count >= 8 else { return nil }
        offset = data.prefix(8).reduce(0) { ($0 << 8) | UInt64($1) }
        bytes = Data(data.dropFirst(8))
    }

    public var encoded: Data {
        var d = Data(count: 8)
        for i in 0..<8 { d[i] = UInt8((offset >> (56 - 8 * UInt64(i))) & 0xff) }
        d.append(bytes)
        return d
    }
}

/// `attached` and `resync`: where the catch-up frame that follows starts and ends.
public struct PtyAttach: Codable, Equatable, Sendable {
    public var clientId: UInt64?
    /// `resume` appends to what the terminal shows; `snapshot` replaces it.
    public var mode: String
    public var startOffset: UInt64
    public var endOffset: UInt64
    public var lostBytes: UInt64?
    public var cols: UInt16?
    public var rows: UInt16?
    public var owner: UInt64?

    public var isSnapshot: Bool { mode != "resume" }

    public init(clientId: UInt64? = nil, mode: String, startOffset: UInt64, endOffset: UInt64,
                lostBytes: UInt64? = nil, cols: UInt16? = nil, rows: UInt16? = nil, owner: UInt64? = nil) {
        self.clientId = clientId
        self.mode = mode
        self.startOffset = startOffset
        self.endOffset = endOffset
        self.lostBytes = lostBytes
        self.cols = cols
        self.rows = rows
        self.owner = owner
    }
}

public enum PtyServerMessage: Equatable, Sendable {
    case attached(PtyAttach)
    case resync(PtyAttach)
    case size(cols: UInt16, rows: UInt16, owner: UInt64?)
    case exit(code: Int?)
    /// A refusal retrying won't fix; the server closes with 4400 next.
    case error(String)
    case unknown

    public static func decode(_ text: String) -> PtyServerMessage {
        let data = Data(text.utf8)
        guard let v = try? JSONDecoder().decode(JSONValue.self, from: data),
              let type = v["type"]?.stringValue else { return .unknown }
        func number(_ k: String) -> Double? {
            if case .number(let n)? = v[k] { return n }
            return nil
        }
        switch type {
        case "attached", "resync":
            guard let a = try? JSONDecoder().decode(PtyAttach.self, from: data) else { return .unknown }
            return type == "attached" ? .attached(a) : .resync(a)
        case "size":
            return .size(cols: UInt16(number("cols") ?? 0), rows: UInt16(number("rows") ?? 0),
                         owner: number("owner").map { UInt64($0) })
        case "exit": return .exit(code: number("code").map { Int($0) })
        case "error": return .error(v["error"]?.stringValue ?? "the terminal refused to attach")
        default: return .unknown
        }
    }
}

public enum PtyClientMessage: Sendable {
    case resize(cols: UInt16, rows: UInt16)
    case focus

    var text: String {
        let v: JSONValue
        switch self {
        case .resize(let cols, let rows):
            v = .object(["type": .string("resize"), "cols": .number(Double(cols)), "rows": .number(Double(rows))])
        case .focus:
            v = .object(["type": .string("focus")])
        }
        return String(decoding: (try? JSONEncoder().encode(v)) ?? Data(), as: UTF8.self)
    }
}

/// What to feed the terminal for each frame, and where the stream got to.
public struct PtyStreamState: Equatable, Sendable {
    /// One past the last byte fed: the `offset` to resume from.
    public private(set) var nextOffset: UInt64?
    private var resetBeforeNextFrame = false

    public init() {}

    /// Records an `attached` or `resync` header. A snapshot means the next
    /// frame replaces the screen.
    public mutating func header(_ a: PtyAttach) {
        if a.isSnapshot { resetBeforeNextFrame = true }
    }

    /// Returns whether to clear the terminal first, and the bytes to feed.
    /// Bytes already fed are trimmed, so a frame that overlaps never repeats output.
    public mutating func accept(_ frame: PtyFrame) -> (reset: Bool, bytes: Data) {
        let end = frame.offset + UInt64(frame.bytes.count)
        if resetBeforeNextFrame {
            resetBeforeNextFrame = false
            nextOffset = end
            return (true, frame.bytes)
        }
        var bytes = frame.bytes
        if let next = nextOffset, frame.offset < next {
            let overlap = Int(min(next - frame.offset, UInt64(bytes.count)))
            bytes = Data(bytes.dropFirst(overlap))
        }
        nextOffset = max(nextOffset ?? 0, end)
        return (false, bytes)
    }
}

/// One terminal attached to one PTY session. Reconnects after a drop and
/// resumes from the last byte it fed.
public actor PtyConnection {
    public enum Update: Sendable, Equatable {
        /// Clear the screen before the next output.
        case reset
        case output(Data)
        case size(cols: UInt16, rows: UInt16, owner: UInt64?)
        case exit(code: Int?)
        /// The server refused the attach; `refused(4400)` follows.
        case error(String)
        case signedOut
        /// 4400 or 4403. The connection has ended.
        case refused(code: Int)
        case reconnecting
    }

    public nonisolated let updates: AsyncStream<Update>
    private let continuation: AsyncStream<Update>.Continuation
    private let url: URL
    private let token: String
    private let opener: any WebSocketOpener
    private let sleep: Sleeper
    private let cwd: String?
    private var cols: UInt16
    private var rows: UInt16
    private var state = PtyStreamState()
    private var socket: (any WebSocketConnection)?
    private var task: Task<Void, Never>?
    private var exited = false
    private let mayReconnect: (@Sendable () async -> Bool)?
    /// The server closes a socket that sends more than this in one message.
    static let maxInputBytes = 64 * 1024

    /// `mayReconnect` runs before each reconnect; false ends the connection.
    public init(baseURL: URL, token: String, sessionId: String, cols: UInt16, rows: UInt16,
                cwd: String? = nil, mayReconnect: (@Sendable () async -> Bool)? = nil,
                opener: any WebSocketOpener = URLSessionWebSocketOpener(), sleep: @escaping Sleeper = realSleep) {
        self.mayReconnect = mayReconnect
        self.url = baseURL.webSocketURL(path: "/api/pty/\(encodePathSegment(sessionId))") ?? baseURL
        self.token = token
        self.cols = cols
        self.rows = rows
        self.cwd = cwd
        self.opener = opener
        self.sleep = sleep
        (updates, continuation) = AsyncStream.makeStream(of: Update.self)
    }

    public var nextOffset: UInt64? { state.nextOffset }

    public func start() {
        guard task == nil else { return }
        task = Task { await run() }
    }

    public func stop() {
        task?.cancel()
        socket?.close()
        continuation.finish()
    }

    /// Keystrokes, as binary frames, split so a large paste stays under
    /// `maxInputBytes` a message.
    public func send(input: Data) async {
        guard let socket else { return }
        var rest = input[...]
        while !rest.isEmpty {
            let chunk = rest.prefix(Self.maxInputBytes)
            rest = rest.dropFirst(chunk.count)
            try? await socket.send(.data(Data(chunk)))
        }
    }

    public func resize(cols: UInt16, rows: UInt16) async {
        guard cols > 0, rows > 0 else { return }
        self.cols = cols
        self.rows = rows
        try? await socket?.send(.text(PtyClientMessage.resize(cols: cols, rows: rows).text))
    }

    /// Takes over the PTY size, as typing does.
    public func focus() async {
        try? await socket?.send(.text(PtyClientMessage.focus.text))
    }

    func hello() -> String {
        var extra: [String: JSONValue] = [
            "cols": .number(Double(cols)),
            "rows": .number(Double(rows)),
        ]
        if let offset = state.nextOffset { extra["offset"] = .number(Double(offset)) }
        if let cwd { extra["cwd"] = .string(cwd) }
        return authHello(token: token, extra)
    }

    private func run() async {
        connecting: while !Task.isCancelled {
            let socket = opener.open(url)
            self.socket = socket
            do {
                try await socket.send(.text(hello()))
                while true {
                    switch try await socket.receive() {
                    case .data(let data):
                        guard let frame = PtyFrame(data) else { continue }
                        let (reset, bytes) = state.accept(frame)
                        if reset { continuation.yield(.reset) }
                        if !bytes.isEmpty { continuation.yield(.output(bytes)) }
                    case .text(let text):
                        switch PtyServerMessage.decode(text) {
                        case .attached(let a), .resync(let a): state.header(a)
                        case .size(let c, let r, let o): continuation.yield(.size(cols: c, rows: r, owner: o))
                        case .exit(let code):
                            exited = true
                            continuation.yield(.exit(code: code))
                        case .error(let message): continuation.yield(.error(message))
                        case .unknown: break
                        }
                    }
                }
            } catch let closed as WebSocketClosed {
                if exited { break connecting }
                switch closeAction(for: closed.code) {
                case .signOut:
                    continuation.yield(.signedOut)
                    continuation.finish()
                    return
                case .stop:
                    continuation.yield(.refused(code: closed.code))
                    continuation.finish()
                    return
                case .retry:
                    break
                }
            } catch {
                if exited { break connecting }
            }
            self.socket = nil
            if Task.isCancelled { return }
            continuation.yield(.reconnecting)
            // A flat second: a terminal someone is looking
            // at should come back quickly, and a refusal never retries.
            do { try await sleep(.seconds(1)) } catch { return }
            // Attaching to an id with nothing running spawns a plain shell
            // there, which must not happen under an agent session's id.
            if let mayReconnect, await !mayReconnect() {
                continuation.yield(.refused(code: 1000))
                break connecting
            }
        }
        continuation.finish()
    }
}
