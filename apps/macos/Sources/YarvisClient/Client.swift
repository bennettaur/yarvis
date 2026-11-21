import Foundation

public enum YarvisError: Error, Equatable, LocalizedError {
    /// 401: the token is unknown, revoked or expired. Sign in again.
    case unauthorized
    /// 403 `reauth_required`: the route wants a code check from the last 10 minutes.
    case reauthRequired
    case http(status: Int, error: String, detail: String?)
    case badResponse

    public var errorDescription: String? {
        switch self {
        case .unauthorized: return "Signed out. Sign in again."
        case .reauthRequired: return "This needs a fresh authenticator code."
        case .http(_, let error, let detail):
            return detail.map { "\(error): \($0)" } ?? error
        case .badResponse: return "The server sent something this app can't read."
        }
    }
}

/// A sign-in, before there is a token.
public struct SignInRequest: Sendable {
    public var passphrase: String
    /// A six-digit authenticator code, or a backup code.
    public var code: String
    public var isBackupCode: Bool
    public var deviceName: String

    public init(passphrase: String, code: String, isBackupCode: Bool = false, deviceName: String) {
        self.passphrase = passphrase
        self.code = code
        self.isBackupCode = isBackupCode
        self.deviceName = deviceName
    }
}

/// The HTTP side of the server API. Every call carries the device token as a
/// bearer header. WebSockets live in `EventStream` and `PtyConnection`.
public final class YarvisClient: Sendable {
    public let baseURL: URL
    public let token: String
    let session: URLSession
    /// Called on any 401, so the app can drop the token and show sign-in.
    let onUnauthorized: @Sendable () -> Void

    public init(baseURL: URL, token: String, session: URLSession = .shared,
                onUnauthorized: @escaping @Sendable () -> Void = {}) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        self.onUnauthorized = onUnauthorized
    }

    // MARK: Sign-in (no token)

    public static func status(baseURL: URL, session: URLSession = .shared) async throws -> AuthStatus {
        var req = URLRequest(url: try url(baseURL, "/api/auth/status"))
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, res) = try await session.data(for: req)
        try check(data, res)
        return try decode(AuthStatus.self, data)
    }

    /// Signs in with the passphrase and an authenticator or backup code, and
    /// creates a device for this app.
    public static func signIn(baseURL: URL, _ r: SignInRequest,
                              session: URLSession = .shared) async throws -> SignedIn {
        var body: [String: JSONValue] = [
            "passphrase": .string(r.passphrase),
            "deviceName": .string(r.deviceName),
        ]
        body[r.isBackupCode ? "backupCode" : "code"] = .string(r.code)
        var req = URLRequest(url: try url(baseURL, "/api/auth/login"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(JSONValue.object(body))
        let (data, res) = try await session.data(for: req)
        // A 401 here is a wrong passphrase or code, not a lost device.
        try check(data, res)
        return try decode(SignedIn.self, data)
    }

    // MARK: Requests

    func request(_ method: String, _ path: String, body: JSONValue? = nil) throws -> URLRequest {
        var req = URLRequest(url: try Self.url(baseURL, path))
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        return req
    }

    /// Sends a request and returns the body of a 2xx answer.
    @discardableResult
    func send(_ method: String, _ path: String, body: JSONValue? = nil) async throws -> Data {
        let (data, res) = try await session.data(for: request(method, path, body: body))
        try checkAuthed(data, res)
        return data
    }

    func get<T: Decodable>(_ type: T.Type, _ path: String) async throws -> T {
        try Self.decode(type, await send("GET", path))
    }

    func post<T: Decodable>(_ type: T.Type, _ path: String, body: JSONValue? = nil) async throws -> T {
        try Self.decode(type, await send("POST", path, body: body ?? .object([:])))
    }

    func checkAuthed(_ data: Data, _ res: URLResponse) throws {
        do {
            try Self.check(data, res)
        } catch YarvisError.unauthorized {
            onUnauthorized()
            throw YarvisError.unauthorized
        }
    }

    static func url(_ base: URL, _ path: String) throws -> URL {
        guard let url = base.appendingAPIPath(path) else { throw YarvisError.badResponse }
        return url
    }

    static func check(_ data: Data, _ res: URLResponse) throws {
        guard let http = res as? HTTPURLResponse else { throw YarvisError.badResponse }
        if (200..<300).contains(http.statusCode) { return }
        let body = try? JSONDecoder().decode(APIErrorBody.self, from: data)
        if http.statusCode == 401 { throw YarvisError.unauthorized }
        if http.statusCode == 403, body?.error == "reauth_required" { throw YarvisError.reauthRequired }
        throw YarvisError.http(status: http.statusCode,
                               error: body?.error ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode),
                               detail: body?.detail)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw YarvisError.badResponse
        }
    }

    // MARK: Auth with a token

    public func me() async throws -> Device {
        try await get(Device.self, "/api/devices/me")
    }

    /// Makes this device fresh for 10 minutes with an authenticator code.
    public func reverify(code: String) async throws {
        try await send("POST", "/api/auth/reverify", body: .object(["code": .string(code)]))
    }

    /// Runs `action`. If the server answers `reauth_required`, asks `code` for
    /// an authenticator code, reverifies and runs `action` once more. A nil
    /// code cancels and rethrows the refusal.
    public func withFreshCode<T: Sendable>(
        _ code: @Sendable () async -> String?,
        _ action: @Sendable () async throws -> T
    ) async throws -> T {
        do {
            return try await action()
        } catch YarvisError.reauthRequired {
            guard let entered = await code() else { throw YarvisError.reauthRequired }
            try await reverify(code: entered)
            return try await action()
        }
    }

    // MARK: Approvals

    public func approvals() async throws -> [Approval] {
        try await get([Approval].self, "/api/approvals")
    }

    /// A 409 means another device answered first, or it timed out.
    public func answerApproval(id: String, approve: Bool) async throws {
        try await send("POST", "/api/approvals/\(encodePathSegment(id))",
                       body: .object(["approve": .bool(approve)]))
    }

    // MARK: Core commands

    /// `POST /api/core/{command}`, with the frontend's camelCase arguments.
    func core(_ command: String, _ args: [String: JSONValue] = [:]) async throws -> Data {
        try await send("POST", "/api/core/\(encodePathSegment(command))", body: .object(args))
    }

    /// True while a shell runs in session `id`, without spawning one.
    public func ptyExists(_ id: String) async throws -> Bool {
        try Self.decode(Bool.self, await core("pty_exists", ["id": .string(id)]))
    }

    public func ptyKill(_ id: String) async throws {
        _ = try await core("pty_kill", ["id": .string(id)])
    }

    /// Starts the agent session `ws-claude:<workspaceId>` in the workspace's folder.
    public func startAgentSession(workspace: WorkspaceSummary) async throws {
        _ = try await core("pty_start_claude", [
            "workspaceId": .string(workspace.id),
            "cwd": .string(workspace.rootPath),
            "name": .string(workspace.name),
            "remoteControl": .bool(false),
        ])
    }

    // MARK: Sidecar

    /// A sidecar path such as `/api/chat` reached through the server's proxy.
    static func sidecar(_ path: String) -> String { "/api/sidecar\(path)" }

    public func workspaces() async throws -> [WorkspaceSummary] {
        try await get([WorkspaceSummary].self, Self.sidecar("/api/workspaces"))
    }
}
