import Foundation

/// Splits a `text/event-stream` body into the `data` of each event. The
/// sidecar sends one `data:` line per event and no `event:` or `id:` lines,
/// but multi-line data is joined with newlines as the spec says.
public struct SSEParser: Sendable {
    private var data: [String] = []

    public init() {}

    /// Feeds one line, without its line ending. Returns an event's data when
    /// the line is the blank line that ends it.
    public mutating func feed(line: String) -> String? {
        if line.isEmpty {
            defer { data.removeAll() }
            return data.isEmpty ? nil : data.joined(separator: "\n")
        }
        if line.hasPrefix(":") { return nil }
        guard line.hasPrefix("data:") else { return nil }
        var value = line.dropFirst(5)
        if value.first == " " { value = value.dropFirst() }
        data.append(String(value))
        return nil
    }
}

extension YarvisClient {
    /// Opens an SSE request and yields each event's data. Cancelling the
    /// consuming task closes the connection, which is how a chat turn is stopped.
    func eventStream(_ request: URLRequest) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = request
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    req.timeoutInterval = 24 * 60 * 60
                    let (bytes, res) = try await session.bytes(for: req)
                    if let http = res as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        var body = Data()
                        for try await b in bytes { body.append(b) }
                        try checkAuthed(body, res)
                    }
                    var parser = SSEParser()
                    // `bytes.lines` drops blank lines, which end SSE events,
                    // so lines are split by hand.
                    var line = Data()
                    for try await b in bytes {
                        if b == UInt8(ascii: "\n") {
                            if line.last == UInt8(ascii: "\r") { line.removeLast() }
                            if let event = parser.feed(line: String(decoding: line, as: UTF8.self)) {
                                continuation.yield(Data(event.utf8))
                            }
                            line.removeAll(keepingCapacity: true)
                        } else {
                            line.append(b)
                        }
                    }
                    if !line.isEmpty, let event = parser.feed(line: String(decoding: line, as: UTF8.self)) {
                        continuation.yield(Data(event.utf8))
                    }
                    if let event = parser.feed(line: "") { continuation.yield(Data(event.utf8)) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
