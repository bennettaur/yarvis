import Foundation

/// The server's event stream (`/api/events`): alarms, approvals, devices, the
/// sidecar restarting. One socket that reconnects on its own and asks for what
/// it missed with `since`.
public actor EventStream {
    public enum Update: Sendable, Equatable {
        case event(ServerEvent)
        /// The client fell too far behind: reload what's on screen. The stream
        /// reconnects from now.
        case lagged
        /// 4401. The token is no good; sign in again. The stream has ended.
        case signedOut
        /// 4400 or 4403. The stream has ended.
        case refused(code: Int)
        case disconnected(retryIn: Duration)
    }

    public nonisolated let updates: AsyncStream<Update>
    private let continuation: AsyncStream<Update>.Continuation
    private let url: URL
    private let token: String
    private let opener: any WebSocketOpener
    private let sleep: Sleeper
    private var backoff = Backoff(min: .seconds(1), max: .seconds(30))
    private var task: Task<Void, Never>?
    private var socket: (any WebSocketConnection)?
    /// The highest `seq` seen, sent as `since` on the next connect.
    public private(set) var lastSeq: Int64?

    /// `since` replays events after that `seq` on the first connect; nil
    /// starts from now.
    public init(baseURL: URL, token: String, since: Int64? = nil,
                opener: any WebSocketOpener = URLSessionWebSocketOpener(), sleep: @escaping Sleeper = realSleep) {
        self.lastSeq = since
        self.url = baseURL.webSocketURL(path: "/api/events") ?? baseURL
        self.token = token
        self.opener = opener
        self.sleep = sleep
        (updates, continuation) = AsyncStream.makeStream(of: Update.self)
    }

    public func start() {
        guard task == nil else { return }
        task = Task { await run() }
    }

    public func stop() {
        task?.cancel()
        socket?.close()
        continuation.finish()
    }

    private enum Incoming {
        case event(ServerEvent)
        case lagged
        case other
    }

    private static func parse(_ text: String) -> Incoming {
        struct Tag: Decodable { var type: String }
        let data = Data(text.utf8)
        guard let tag = try? JSONDecoder().decode(Tag.self, from: data) else { return .other }
        switch tag.type {
        case "lagged": return .lagged
        case "event": return (try? JSONDecoder().decode(ServerEvent.self, from: data)).map(Incoming.event) ?? .other
        default: return .other
        }
    }

    private func run() async {
        while !Task.isCancelled {
            let socket = opener.open(url)
            self.socket = socket
            var hello: [String: JSONValue] = [:]
            if let lastSeq { hello["since"] = .number(Double(lastSeq)) }
            var reconnectNow = false
            do {
                try await socket.send(.text(authHello(token: token, hello)))
                receiving: while true {
                    guard case .text(let text) = try await socket.receive() else { continue }
                    switch Self.parse(text) {
                    case .event(let event):
                        backoff.reset()
                        if let lastSeq, event.seq <= lastSeq { continue }
                        lastSeq = event.seq
                        continuation.yield(.event(event))
                    case .lagged:
                        lastSeq = nil
                        continuation.yield(.lagged)
                        socket.close()
                        reconnectNow = true
                        break receiving
                    case .other:
                        continue
                    }
                }
            } catch let closed as WebSocketClosed {
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
                // A dropped connection: back off and reconnect.
            }
            if Task.isCancelled { return }
            if reconnectNow { continue }
            let wait = backoff.take()
            continuation.yield(.disconnected(retryIn: wait))
            do { try await sleep(wait) } catch { return }
        }
    }
}
