import Foundation

/// A terminal's colours, as `#rrggbb` (or `#rrggbbaa`) strings. These are the
/// web UI's `TERMINAL_THEMES`, chosen by the same `colorTheme` server
/// setting, so a terminal looks the same in both.
public struct TerminalTheme: Equatable, Sendable {
    public var background: String
    public var foreground: String
    public var cursor: String
    /// Solid and light, unlike the web's see-through selection: SwiftTerm
    /// always draws selected text in black, which a dark blend would hide.
    public var selection: String
    /// The 16 ANSI colours: the 8 normal ones, then the 8 bright ones.
    public var ansi: [String]

    /// The web's default theme names only the background and text and keeps
    /// xterm's own ANSI set (Tango) and white cursor, so this does too.
    public static let standard = TerminalTheme(
        background: "#09090b", foreground: "#e4e4e7", cursor: "#ffffff", selection: "#a1a1aa",
        ansi: ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
               "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"])

    public static let palenight = TerminalTheme(
        background: "#292d3e", foreground: "#a6accd", cursor: "#ffcc00", selection: "#a6accd",
        ansi: ["#292d3e", "#f07178", "#c3e88d", "#ffcb6b", "#82aaff", "#c792ea", "#89ddff", "#d0d0d0",
               "#676e95", "#ff8b92", "#ddffa7", "#ffe585", "#9cc4ff", "#e1acff", "#a3f7ff", "#ffffff"])

    /// The theme for a stored `colorTheme`. Anything unknown, including a
    /// value from another build or a hand edit, is the default.
    public static func named(_ raw: String?) -> TerminalTheme {
        raw == "palenight" ? .palenight : .standard
    }
}

/// Red, green, blue and alpha in 0...1 from `#rrggbb` or `#rrggbbaa`; nil for
/// anything else.
public func parseHexColor(_ hex: String) -> (red: Double, green: Double, blue: Double, alpha: Double)? {
    guard hex.hasPrefix("#") else { return nil }
    let digits = hex.dropFirst()
    guard digits.count == 6 || digits.count == 8, let value = UInt32(digits, radix: 16) else { return nil }
    let rgba = digits.count == 6 ? value << 8 | 0xff : value
    func channel(_ shift: UInt32) -> Double { Double((rgba >> shift) & 0xff) / 255 }
    return (channel(24), channel(16), channel(8), channel(0))
}
