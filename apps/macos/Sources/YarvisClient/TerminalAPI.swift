import Foundation

/// The size every terminal shares, as the web's `terminalFont.ts` keeps it.
public enum TerminalFontSize {
    public static let defaultSize = 16
    public static let range = 10...32
    public static let family = "Menlo"

    /// A stored size, clamped, since `settings.json` is hand-editable. Nil,
    /// zero or a non-number is the default.
    public static func from(_ raw: Double?) -> Int {
        guard let raw, raw.isFinite, raw > 0 else { return defaultSize }
        return clamp(Int(raw.rounded()))
    }

    public static func clamp(_ size: Int) -> Int {
        min(range.upperBound, max(range.lowerBound, size))
    }

    /// What to save: nil for the default, so the server keeps no override.
    public static func stored(_ size: Int) -> Int? {
        size == defaultSize ? nil : size
    }
}

/// `get_agent_config`: the agent command and the harnesses a session can
/// start with.
public struct AgentConfig: Codable, Sendable, Equatable {
    public struct Harness: Codable, Sendable, Equatable, Identifiable {
        public var id: String
        public var name: String
        public var kind: String?
        public var command: String?
    }

    public var name: String
    public var command: String
    public var harnesses: [Harness]
    public var defaultHarness: String?
}

extension YarvisClient {
    /// True while something other than the shell runs in the foreground.
    /// Errors count as idle, as the web treats them, so a close isn't blocked
    /// by a session the server no longer has.
    public func ptyIsBusy(_ id: String) async -> Bool {
        guard let data = try? await core("pty_is_busy", ["id": .string(id)]) else { return false }
        return (try? Self.decode(Bool.self, data)) ?? false
    }

    public func ptySessionHarness(_ id: String) async throws -> PtySession.Harness? {
        try Self.decode(PtySession.Harness?.self, await core("pty_session_harness", ["id": .string(id)]))
    }

    public func agentConfig() async throws -> AgentConfig {
        try Self.decode(AgentConfig.self, await core("get_agent_config"))
    }

    /// The saved terminal font size, clamped, from `get_settings`.
    public func terminalFontSize() async throws -> Int {
        let settings = try Self.decode(JSONValue.self, await core("get_settings"))
        if case .number(let n)? = settings["terminalFontSize"] { return TerminalFontSize.from(n) }
        return TerminalFontSize.defaultSize
    }

    /// Saves the size every terminal uses; nil goes back to the default. Needs `admin`.
    public func setTerminalFontSize(_ size: Int?) async throws {
        _ = try await core("set_terminal_font_size", ["value": size.map { .number(Double($0)) } ?? .null])
    }
}
