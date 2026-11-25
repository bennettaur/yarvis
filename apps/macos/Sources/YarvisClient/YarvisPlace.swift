import Foundation

/// A place in the app a `yarvis://` link sends the user, as the web's
/// `parseAppPlace`, `artifactLink` and `workspaceMentions` read them.
public enum YarvisPlace: Equatable, Sendable {
    /// A nav tab by the web's id, such as `chat`, `terminal` or `prs`.
    case tab(String)
    /// Settings, or one of its tabs by the web's key, such as `devices`.
    case settings(String?)
    case workspace(id: String)
    case artifact(id: String)
    case setup
    case tour

    /// Reads `yarvis://tab/<tab>`, `yarvis://settings[/<tab>]`, `yarvis://setup`,
    /// `yarvis://tour`, `yarvis://workspace/<uuid>` and `yarvis://artifact/<uuid>`,
    /// each with an optional trailing slash. Anything else is nil, so a
    /// mistyped link stays inert rather than landing somewhere unexpected.
    public init?(_ url: URL) {
        self.init(url.absoluteString)
    }

    public init?(_ href: String) {
        let scheme = "yarvis://"
        guard href.hasPrefix(scheme) else { return nil }
        var rest = String(href.dropFirst(scheme.count))
        if rest.hasSuffix("/") { rest.removeLast() }
        let parts = rest.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard (1...2).contains(parts.count), parts.allSatisfy({ !$0.isEmpty }) else { return nil }
        let name = parts.count == 2 ? parts[1] : nil
        switch (parts[0], name) {
        case ("setup", nil): self = .setup
        case ("tour", nil): self = .tour
        case ("settings", let tab): self = .settings(tab)
        case ("tab", let tab?): self = .tab(tab)
        case ("workspace", let id?) where UUID(uuidString: id) != nil: self = .workspace(id: id.lowercased())
        case ("artifact", let id?) where UUID(uuidString: id) != nil: self = .artifact(id: id.lowercased())
        default: return nil
        }
    }
}
