import Foundation

public enum WebSocketMessage: Sendable, Equatable {
    case text(String)
    case data(Data)
}

/// The server closed the socket with `code`. Codes 4400, 4401 and 4403 are
/// the server refusing the request; see `closeAction(for:)`.
public struct WebSocketClosed: Error, Equatable {
    public var code: Int
    public var reason: String

    public init(code: Int, reason: String = "") {
        self.code = code
        self.reason = reason
    }
}

/// One WebSocket. A protocol so tests can drive the events and PTY clients
/// without a server.
public protocol WebSocketConnection: Sendable {
    func send(_ message: WebSocketMessage) async throws
    /// The next message. Throws `WebSocketClosed` when the server closed the
    /// socket with a code, or another error when the connection dropped.
    func receive() async throws -> WebSocketMessage
    func close()
}

public protocol WebSocketOpener: Sendable {
    func open(_ url: URL) -> any WebSocketConnection
}

/// What a client should do after the server closes a socket.
public enum CloseAction: Equatable, Sendable {
    /// 4401: the token is no good. Forget it and show sign-in.
    case signOut
    /// 4400 or 4403 (any 4xxx): retrying won't change the answer.
    case stop
    /// 1011, a normal close or a dropped network: reconnect with backoff.
    case retry
}

public func closeAction(for code: Int) -> CloseAction {
    if code == 4401 { return .signOut }
    if (4000..<5000).contains(code) { return .stop }
    return .retry
}

/// `URLSessionWebSocketTask` behind `WebSocketConnection`.
public struct URLSessionWebSocketOpener: WebSocketOpener {
    let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func open(_ url: URL) -> any WebSocketConnection {
        URLSessionSocket(task: session.webSocketTask(with: url))
    }
}

final class URLSessionSocket: WebSocketConnection, @unchecked Sendable {
    // `URLSessionWebSocketTask` is thread-safe; it just isn't marked Sendable.
    private let task: URLSessionWebSocketTask

    /// A PTY catch-up frame can hold 1 MiB of scrollback plus its offset,
    /// which is past the task's 1 MiB default.
    private static let maxMessageBytes = 8 * 1024 * 1024

    init(task: URLSessionWebSocketTask) {
        self.task = task
        task.maximumMessageSize = Self.maxMessageBytes
        task.resume()
    }

    func send(_ message: WebSocketMessage) async throws {
        switch message {
        case .text(let s): try await task.send(.string(s))
        case .data(let d): try await task.send(.data(d))
        }
    }

    func receive() async throws -> WebSocketMessage {
        do {
            switch try await task.receive() {
            case .string(let s): return .text(s)
            case .data(let d): return .data(d)
            @unknown default: return .data(Data())
            }
        } catch {
            let code = task.closeCode.rawValue
            if code != URLSessionWebSocketTask.CloseCode.invalid.rawValue {
                let reason = task.closeReason.map { String(decoding: $0, as: UTF8.self) } ?? ""
                throw WebSocketClosed(code: code, reason: reason)
            }
            throw error
        }
    }

    func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}

/// The first message every server socket wants: the token plus the route's fields.
func authHello(token: String, _ extra: [String: JSONValue]) -> String {
    var o = extra
    o["type"] = .string("auth")
    o["token"] = .string(token)
    let data = (try? JSONEncoder().encode(JSONValue.object(o))) ?? Data()
    return String(decoding: data, as: UTF8.self)
}

/// How long to wait before reconnecting: doubling from `min` up to `max`.
public struct Backoff: Sendable, Equatable {
    public let min: Duration
    public let max: Duration
    public private(set) var next: Duration

    public init(min: Duration, max: Duration) {
        self.min = min
        self.max = max
        self.next = min
    }

    public mutating func take() -> Duration {
        defer { next = Swift.min(next * 2, max) }
        return next
    }

    public mutating func reset() { next = min }
}

public typealias Sleeper = @Sendable (Duration) async throws -> Void

public let realSleep: Sleeper = { try await Task.sleep(for: $0) }
