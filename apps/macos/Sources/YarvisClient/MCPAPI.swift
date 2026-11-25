import Foundation

/// An MCP server Yarvis connects out to (sidecar `mcp/routes.ts`).
public struct McpServer: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var name: String
    public var transport: String
    public var url: String?
    /// True when the server signs in with OAuth.
    public var oauth: Bool
    public var enabled: Bool

    public init(id: String, name: String, transport: String = "http", url: String? = nil, oauth: Bool = false,
                enabled: Bool = true) {
        self.id = id
        self.name = name
        self.transport = transport
        self.url = url
        self.oauth = oauth
        self.enabled = enabled
    }
}

public struct McpServerStatus: Codable, Sendable, Equatable {
    public struct OAuth: Codable, Sendable, Equatable {
        public var registered: Bool?
        public var authorized: Bool

        public init(registered: Bool? = nil, authorized: Bool) {
            self.registered = registered
            self.authorized = authorized
        }
    }

    public var connected: Bool
    public var toolCount: Int?
    public var oauth: OAuth?

    public init(connected: Bool, toolCount: Int? = nil, oauth: OAuth? = nil) {
        self.connected = connected
        self.toolCount = toolCount
        self.oauth = oauth
    }
}

/// What a Reconnect reports.
public struct McpRefreshResult: Codable, Sendable, Equatable {
    public var connected: Bool
    public var error: String?
    public var needsAuthorization: Bool?
    public var authorizationUrl: String?
}

/// An enabled MCP server the chat can't use right now, and what fixes it.
public struct McpConnectionIssue: Equatable, Sendable, Identifiable {
    public enum Fix: Equatable, Sendable {
        /// Sign in with OAuth.
        case authorize
        case reconnect
    }

    public var server: McpServer
    public var fix: Fix
    public var id: String { server.id }

    /// The issue for one server, or nil when it's usable or switched off.
    /// An OAuth server that isn't signed in needs that first, since a
    /// reconnect would only fail on it.
    public static func of(_ server: McpServer, status: McpServerStatus) -> McpConnectionIssue? {
        guard server.enabled else { return nil }
        if server.oauth, status.oauth?.authorized != true { return McpConnectionIssue(server: server, fix: .authorize) }
        if !status.connected { return McpConnectionIssue(server: server, fix: .reconnect) }
        return nil
    }
}

extension YarvisClient {
    public func mcpServers() async throws -> [McpServer] {
        try await get([McpServer].self, Self.sidecar("/api/mcp/servers"))
    }

    public func mcpServerStatus(id: String) async throws -> McpServerStatus {
        try await get(McpServerStatus.self, Self.sidecar("/api/mcp/servers/\(encodePathSegment(id))/status"))
    }

    /// Every enabled server that isn't usable. A server whose status can't be
    /// read is skipped rather than flagged, since there's nothing to fix yet.
    public func mcpConnectionIssues() async throws -> [McpConnectionIssue] {
        var issues: [McpConnectionIssue] = []
        for server in try await mcpServers() where server.enabled {
            guard let status = try? await mcpServerStatus(id: server.id) else { continue }
            if let issue = McpConnectionIssue.of(server, status: status) { issues.append(issue) }
        }
        return issues
    }

    /// Starts an OAuth sign-in and returns the page to open in the browser.
    public func authorizeMcpServer(id: String) async throws -> URL {
        struct Started: Decodable { var authorizationUrl: String }
        let started = try await post(Started.self, Self.sidecar("/api/mcp/servers/\(encodePathSegment(id))/authorize"))
        guard let url = URL(string: started.authorizationUrl) else { throw YarvisError.badResponse }
        return url
    }

    public func refreshMcpServer(id: String) async throws -> McpRefreshResult {
        try await post(McpRefreshResult.self, Self.sidecar("/api/mcp/servers/\(encodePathSegment(id))/refresh"))
    }

    /// Lets one MCP tool run without asking from now on (`mcp:<server>:<tool>`).
    public func alwaysAllowMcpTool(_ toolId: String) async throws {
        try await send("PATCH", Self.sidecar("/api/mcp/tools/\(encodePathSegment(toolId))"),
                       body: .object(["approval": .string("auto")]))
    }
}
