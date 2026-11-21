import Foundation
@testable import YarvisClient

/// Answers requests for one test's `URLSession` from a handler, and records them.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest, Data?) -> (Int, Data)

    private static let lock = NSLock()
    nonisolated(unsafe) private static var handlers: [String: Handler] = [:]
    nonisolated(unsafe) private static var requests: [String: [(URLRequest, Data?)]] = [:]
    private static let header = "X-Stub-Id"

    /// A session whose requests go to `handler`. Each test gets its own, so
    /// tests running in parallel don't see each other's requests.
    static func session(_ handler: @escaping Handler) -> (URLSession, id: String) {
        let id = UUID().uuidString
        lock.withLock { handlers[id] = handler }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        config.httpAdditionalHeaders = [header: id]
        return (URLSession(configuration: config), id)
    }

    static func recorded(_ id: String) -> [(URLRequest, Data?)] {
        lock.withLock { requests[id] ?? [] }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let id = request.value(forHTTPHeaderField: Self.header) ?? ""
        let body = request.httpBody ?? request.httpBodyStream.map(Self.read)
        let handler = Self.lock.withLock { () -> Handler? in
            Self.requests[id, default: []].append((request, body))
            return Self.handlers[id]
        }
        let (status, data) = handler?(request, body) ?? (500, Data())
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

func json(_ s: String) -> Data { Data(s.utf8) }

func bodyJSON(_ data: Data?) -> JSONValue? {
    data.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
}

let base = URL(string: "https://yarvis.example.ts.net")!

/// A scripted WebSocket: `receive` returns `script` in order, then reports a
/// dropped connection. Everything sent is recorded.
final class FakeSocket: WebSocketConnection, @unchecked Sendable {
    enum Step {
        case message(WebSocketMessage)
        case close(Int)
    }

    private let lock = NSLock()
    private var script: [Step]
    private var _sent: [WebSocketMessage] = []
    private var _closed = false

    init(_ script: [Step]) {
        self.script = script
    }

    var sent: [WebSocketMessage] { lock.withLock { _sent } }
    var closed: Bool { lock.withLock { _closed } }

    /// The first message sent, parsed: the auth hello.
    var hello: JSONValue? {
        guard case .text(let t)? = sent.first else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: Data(t.utf8))
    }

    func send(_ message: WebSocketMessage) async throws {
        lock.withLock { _sent.append(message) }
    }

    func receive() async throws -> WebSocketMessage {
        let step = lock.withLock { script.isEmpty ? nil : script.removeFirst() }
        switch step {
        case .message(let m)?: return m
        case .close(let code)?: throw WebSocketClosed(code: code)
        case nil: throw URLError(.networkConnectionLost)
        }
    }

    func close() {
        lock.withLock { _closed = true }
    }
}

/// Hands out `sockets` in order, one per connect, and records each URL.
final class FakeOpener: WebSocketOpener, @unchecked Sendable {
    private let lock = NSLock()
    private var sockets: [FakeSocket]
    private var _urls: [URL] = []

    init(_ sockets: [FakeSocket]) {
        self.sockets = sockets
    }

    var urls: [URL] { lock.withLock { _urls } }

    func open(_ url: URL) -> any WebSocketConnection {
        lock.withLock {
            _urls.append(url)
            // Past the script, every connect is refused so the client stops.
            return sockets.isEmpty ? FakeSocket([.close(4400)]) : sockets.removeFirst()
        }
    }
}

/// A sleeper that records each wait and returns at once.
final class RecordingSleeper: @unchecked Sendable {
    private let lock = NSLock()
    private var _waits: [Duration] = []
    var waits: [Duration] { lock.withLock { _waits } }

    var sleeper: Sleeper {
        { [self] d in lock.withLock { _waits.append(d) } }
    }
}

func eventText(seq: Int64, kind: String = "approval.requested") -> WebSocketMessage {
    .text(#"{"type":"event","seq":\#(seq),"at":1763600000000,"deviceId":null,"kind":"\#(kind)","data":{}}"#)
}

/// Every update a stream yields until it finishes.
func collect<T>(_ stream: AsyncStream<T>) async -> [T] {
    var all: [T] = []
    for await u in stream { all.append(u) }
    return all
}
