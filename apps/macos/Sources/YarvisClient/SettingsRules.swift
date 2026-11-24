import Foundation

/// Checks and wording for the Settings forms, matching the web UI's.
public enum SettingsRules {
    public static let minPassphraseLength = 12

    /// Why a token can't be made yet, or nil when the form is complete.
    public static func tokenProblem(name: String, scopes: Set<Scope>) -> String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Give the token a name, so you can tell it apart later."
        }
        if scopes.isEmpty { return "Pick at least one scope." }
        return nil
    }

    public static func canChangePassphrase(current: String, new: String) -> Bool {
        !current.isEmpty && new.count >= minPassphraseLength
    }

    /// The second line of a device row: `Token · read, chat · last seen …`.
    public static func deviceDetail(_ d: DeviceRecord, formatDate: (Date) -> String) -> String {
        let seen = d.lastSeenAt.map { formatDate(Date(timeIntervalSince1970: Double($0) / 1000)) } ?? "never"
        return "\(d.isToken ? "Token" : "Signed in") · \(d.scopes.joined(separator: ", ")) · last seen \(seen)"
    }

    public static func devicesSignedOut(_ n: Int) -> String {
        "Signed out \(n) other device\(n == 1 ? "" : "s")."
    }

    public static func passphraseChanged(otherDevicesSignedOut n: Int) -> String {
        "Passphrase changed. \(n) other device\(n == 1 ? "" : "s") signed out."
    }

    public static func backupCodesLeft(_ n: Int) -> String {
        "\(n) backup code\(n == 1 ? "" : "s") left."
    }

    /// Devices the list shows: the web UI hides revoked ones.
    public static func active(_ devices: [DeviceRecord]) -> [DeviceRecord] {
        devices.filter { !$0.isRevoked }
    }

    /// True when the app can't start until the vault is dealt with.
    public static func vaultBlocksApp(_ state: String?) -> Bool {
        state == "locked" || state == "uninitialized"
    }
}
