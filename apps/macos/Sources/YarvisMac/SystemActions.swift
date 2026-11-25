import AppKit

/// Opens a link in the browser. Anything but http(s) is dropped, since links
/// come from replies, terminal output and provider data, and another scheme
/// could launch an app.
func openWebLink(_ url: URL) {
    guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
    NSWorkspace.shared.open(url)
}

func openExternal(_ link: String?) {
    guard let link, let url = URL(string: link) else { return }
    openWebLink(url)
}

/// How long a copied secret stays on the clipboard if nothing else is copied.
private let secretClipboardLifetime: Duration = .seconds(60)

/// Puts text on the clipboard. A `secret` (a token, backup codes) is marked
/// concealed and transient, so clipboard managers and Universal Clipboard
/// skip it, and is cleared after a minute unless something else was copied.
@MainActor @discardableResult
func copyToPasteboard(_ text: String, secret: Bool = false) -> Bool {
    let board = NSPasteboard.general
    board.clearContents()
    guard board.setString(text, forType: .string) else { return false }
    guard secret else { return true }
    board.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
    board.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
    let copied = board.changeCount
    Task { @MainActor in
        try? await Task.sleep(for: secretClipboardLifetime)
        if board.changeCount == copied { board.clearContents() }
    }
    return true
}
