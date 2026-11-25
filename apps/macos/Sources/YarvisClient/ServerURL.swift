import Foundation

public enum ServerURLError: Error, Equatable, LocalizedError {
    case invalid
    /// Plain http to anything but this machine would send the token in the clear.
    case insecure

    public var errorDescription: String? {
        switch self {
        case .invalid: return "Enter a server URL such as https://yarvis.example.ts.net"
        case .insecure: return "Use https. Plain http works only for a server on this Mac (localhost)."
        }
    }
}

/// Normalizes what the user typed into the server's origin: `https`, or `http`
/// only on loopback, with no path, query or fragment.
public func parseServerURL(_ input: String) throws -> URL {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard var parts = URLComponents(string: trimmed),
          let scheme = parts.scheme?.lowercased(),
          let host = parts.host, !host.isEmpty,
          parts.user == nil, parts.password == nil
    else { throw ServerURLError.invalid }
    switch scheme {
    case "https": break
    case "http": guard isLoopback(host) else { throw ServerURLError.insecure }
    default: throw ServerURLError.invalid
    }
    guard parts.path.isEmpty || parts.path == "/", parts.query == nil, parts.fragment == nil else {
        throw ServerURLError.invalid
    }
    parts.scheme = scheme
    parts.host = host.lowercased()
    parts.path = ""
    guard let url = parts.url else { throw ServerURLError.invalid }
    return url
}

func isLoopback(_ host: String) -> Bool {
    let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    // Names under `.localhost` aren't trusted: whether they resolve to
    // loopback is up to the resolver, and plain http would send the
    // passphrase in the clear if one didn't.
    if h == "localhost" || h == "::1" { return true }
    let octets = h.split(separator: ".", omittingEmptySubsequences: false)
    return octets.count == 4 && octets[0] == "127" && octets.allSatisfy { UInt8($0) != nil }
}

extension URL {
    /// The WebSocket URL for a server path: `wss` for `https`, `ws` for `http`.
    /// `path` is already percent-encoded.
    func webSocketURL(path: String) -> URL? {
        guard var parts = URLComponents(url: self, resolvingAgainstBaseURL: false) else { return nil }
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        parts.percentEncodedPath = path
        return parts.url
    }

    func appendingAPIPath(_ path: String) -> URL? {
        guard var parts = URLComponents(url: self, resolvingAgainstBaseURL: false) else { return nil }
        let pieces = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        parts.percentEncodedPath = String(pieces[0])
        parts.percentEncodedQuery = pieces.count > 1 ? String(pieces[1]) : nil
        return parts.url
    }
}

func encodeQueryValue(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
}

/// Percent-encodes one path segment. Ids such as `ws:<id>/<tab>/<pane>` hold
/// slashes, which must not become path separators.
public func encodePathSegment(_ s: String) -> String {
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: "/?#%")
    return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
}

/// The key a setting is saved under for one server. Chat tabs, terminal
/// layouts and the selected workspace hold that server's ids, so each server
/// keeps its own copy: another server would open them as empty chats and
/// start shells under the saved pane ids.
public func serverScopedKey(_ key: String, server: URL) -> String {
    "\(server.absoluteString)|\(key)"
}
