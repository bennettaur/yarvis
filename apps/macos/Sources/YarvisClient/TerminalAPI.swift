import Foundation

/// The size every terminal shares. It's one server setting
/// (`terminalFontSize`) for this app and the web UI, so the limits match the
/// web's `terminalFont.ts`.
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

extension YarvisClient {
    /// True while something other than the shell runs in the foreground.
    /// Errors count as idle, so a close isn't blocked
    /// by a session the server no longer has.
    public func ptyIsBusy(_ id: String) async -> Bool {
        guard let data = try? await core("pty_is_busy", ["id": .string(id)]) else { return false }
        return (try? Self.decode(Bool.self, data)) ?? false
    }

    /// The saved terminal font size, clamped, and colour theme, from `get_settings`.
    public func terminalAppearance() async throws -> (fontSize: Int, theme: TerminalTheme) {
        let settings = try Self.decode(JSONValue.self, await core("get_settings"))
        var size = TerminalFontSize.defaultSize
        if case .number(let n)? = settings["terminalFontSize"] { size = TerminalFontSize.from(n) }
        return (size, TerminalTheme.named(settings["colorTheme"]?.stringValue))
    }

    /// Saves the size every terminal uses; nil goes back to the default. Needs `admin`.
    public func setTerminalFontSize(_ size: Int?) async throws {
        _ = try await core("set_terminal_font_size", ["value": size.map { .number(Double($0)) } ?? .null])
    }
}
