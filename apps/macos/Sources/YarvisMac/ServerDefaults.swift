import Foundation
import YarvisClient

/// UserDefaults for settings that belong to one server (see `serverScopedKey`).
struct ServerDefaults {
    let server: URL

    private func key(_ name: String) -> String { serverScopedKey(name, server: server) }

    func data(_ name: String) -> Data? { UserDefaults.standard.data(forKey: key(name)) }
    func string(_ name: String) -> String? { UserDefaults.standard.string(forKey: key(name)) }
    func set(_ value: Any?, _ name: String) { UserDefaults.standard.set(value, forKey: key(name)) }
}
