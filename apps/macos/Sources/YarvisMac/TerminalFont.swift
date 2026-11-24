import AppKit
import SwiftTerm
import YarvisClient

/// The one font size every terminal in the app uses, like the web's
/// `terminalFont.ts`. Saved on the server, so the web UI shares it.
@MainActor
final class TerminalFont {
    static let shared = TerminalFont()

    private(set) var size = TerminalFontSize.defaultSize
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
    }

    /// Reads the saved size once per signed-in client.
    func load(client: YarvisClient) {
        let id = ObjectIdentifier(client)
        guard loadedFrom != id else { return }
        loadedFrom = id
        Task {
            if let saved = try? await client.terminalFontSize() { apply(saved) }
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

    private func apply(_ next: Int) {
        size = next
        let font = self.font
        for view in views.allObjects { view.font = font }
    }
}
