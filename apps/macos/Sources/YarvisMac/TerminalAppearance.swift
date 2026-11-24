import AppKit
import SwiftTerm
import YarvisClient

/// The font size and colours every terminal in the app uses. Both are server
/// settings, so the web UI shares them.
@MainActor
final class TerminalAppearance {
    static let shared = TerminalAppearance()

    private(set) var size = TerminalFontSize.defaultSize
    private(set) var theme = TerminalTheme.standard
    private let views = NSHashTable<TerminalView>.weakObjects()
    private var loadedFrom: ObjectIdentifier?
    /// Cmd+= held down steps faster than a save lands; chaining the saves
    /// leaves the server on the last size rather than whichever write won.
    private var saving: Task<Void, Never>?

    var font: NSFont {
        NSFont(name: TerminalFontSize.family, size: CGFloat(size))
            ?? .monospacedSystemFont(ofSize: CGFloat(size), weight: .regular)
    }

    func attach(_ view: TerminalView) {
        views.add(view)
        view.font = font
        paint(view)
    }

    /// Reads the saved size and theme once per signed-in client.
    func load(client: YarvisClient) {
        let id = ObjectIdentifier(client)
        guard loadedFrom != id else { return }
        loadedFrom = id
        Task {
            guard let saved = try? await client.terminalAppearance() else { return }
            apply(saved.fontSize)
            theme = saved.theme
            for view in views.allObjects { paint(view) }
        }
    }

    /// Steps the size by `delta`, or back to the default for nil, and saves it.
    func step(_ delta: Int?, app: AppModel, client: YarvisClient) {
        let next = delta.map { TerminalFontSize.clamp(size + $0) } ?? TerminalFontSize.defaultSize
        guard next != size else { return }
        apply(next)
        // Saving needs admin. A key chord has nowhere to show an error, and a
        // failed save only means the size reverts on the next launch.
        if let scopes = app.device?.scopes, !scopes.contains(.admin) { return }
        let previous = saving
        let stored = TerminalFontSize.stored(next)
        saving = Task {
            await previous?.value
            try? await client.setTerminalFontSize(stored)
        }
    }

    private func paint(_ view: TerminalView) {
        view.nativeBackgroundColor = nsColor(theme.background)
        view.nativeForegroundColor = nsColor(theme.foreground)
        view.caretColor = nsColor(theme.cursor)
        // The character under a block cursor, as the web's cursorAccent draws it.
        view.caretTextColor = nsColor(theme.background)
        view.selectedTextBackgroundColor = nsColor(theme.selection)
        view.installColors(theme.ansi.map(terminalColor))
    }

    private func apply(_ next: Int) {
        size = next
        let font = self.font
        for view in views.allObjects { view.font = font }
    }
}

private func nsColor(_ hex: String) -> NSColor {
    guard let c = parseHexColor(hex) else { return .textColor }
    return NSColor(srgbRed: c.red, green: c.green, blue: c.blue, alpha: c.alpha)
}

/// SwiftTerm's palette colours take 16-bit channels.
private func terminalColor(_ hex: String) -> SwiftTerm.Color {
    let c = parseHexColor(hex) ?? (0, 0, 0, 1)
    return SwiftTerm.Color(red: UInt16(c.red * 65535), green: UInt16(c.green * 65535), blue: UInt16(c.blue * 65535))
}
