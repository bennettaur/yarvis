import Foundation

/// One row of `GET /api/devices`, which includes revoked devices.
public struct DeviceRecord: Codable, Sendable, Equatable, Identifiable {
    public var deviceId: String
    public var name: String
    /// `login` for a sign-in, `token` for a minted token.
    public var kind: String
    // Strings, so a scope this app doesn't know yet doesn't fail the whole list.
    public var scopes: [String]
    public var createdBy: String?
    public var userAgent: String?
    public var createdAt: Int64
    public var lastSeenAt: Int64?
    public var verifiedAt: Int64?
    public var revokedAt: Int64?
    public var current: Bool

    public init(deviceId: String, name: String, kind: String, scopes: [String], createdBy: String?, userAgent: String?,
                createdAt: Int64, lastSeenAt: Int64?, verifiedAt: Int64?, revokedAt: Int64?, current: Bool) {
        self.deviceId = deviceId
        self.name = name
        self.kind = kind
        self.scopes = scopes
        self.createdBy = createdBy
        self.userAgent = userAgent
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
        self.verifiedAt = verifiedAt
        self.revokedAt = revokedAt
        self.current = current
    }

    public var id: String { deviceId }
    public var isRevoked: Bool { revokedAt != nil }
    public var isToken: Bool { kind == "token" }
}

/// Answer to `POST /api/devices/tokens`. The token is never shown again.
public struct MintedToken: Codable, Sendable, Equatable {
    public var token: String
    public var device: Device
}

/// A pending authenticator change from `POST /api/account/totp/start`.
public struct TotpEnrollment: Codable, Sendable, Equatable {
    public var enrollmentId: String
    /// Base32, for typing into an authenticator by hand.
    public var secret: String
    public var otpauthUri: String
    /// An SVG document of the QR code.
    public var qrSvg: String?
}

/// The scopes a token made from the app can have. `terminal` and `admin`
/// are refused by the server and made with `yarvis-server device add`.
public let mintableScopes: [Scope] = [.read, .chat, .approve]

extension Scope {
    /// What the scope lets a device do, for the token form.
    public var summary: String {
        switch self {
        case .read: return "see data and events"
        case .chat: return "chat and drive workspaces"
        case .terminal: return "open terminals"
        case .approve: return "answer approvals"
        case .admin: return "manage devices and secrets"
        }
    }
}

struct RevokedDevices: Decodable, Sendable {
    var revokedDevices: [String]
}

extension YarvisClient {
    /// Every device the server knows, revoked ones too. Needs `admin`.
    public func devices() async throws -> [DeviceRecord] {
        try await get([DeviceRecord].self, "/api/devices")
    }

    /// Revokes a device. Needs `admin` and a fresh check. Returns when the
    /// server revoked it, in milliseconds since the epoch.
    @discardableResult
    public func revokeDevice(id: String) async throws -> Int64 {
        struct Revoked: Decodable { var revokedAt: Int64 }
        let data = try await send("DELETE", "/api/devices/\(encodePathSegment(id))")
        return try Self.decode(Revoked.self, data).revokedAt
    }

    /// Mints a token for another machine. Needs `admin` and a fresh check.
    public func mintToken(name: String, scopes: [Scope]) async throws -> MintedToken {
        try await post(MintedToken.self, "/api/devices/tokens", body: .object([
            "name": .string(name),
            "scopes": .array(scopes.map { .string($0.rawValue) }),
        ]))
    }

    /// How many backup codes are unused. Needs `admin`.
    public func backupCodesLeft() async throws -> Int {
        struct Account: Decodable { var backupCodesLeft: Int }
        return try await get(Account.self, "/api/account").backupCodesLeft
    }

    /// Changes the passphrase and returns the ids of the devices it signed
    /// out. A wrong current passphrase is a plain 403, not `reauth_required`.
    @discardableResult
    public func changePassphrase(current: String, new: String,
                                 signOutOtherDevices: Bool) async throws -> [String] {
        try await post(RevokedDevices.self, "/api/account/passphrase", body: .object([
            "currentPassphrase": .string(current),
            "newPassphrase": .string(new),
            "signOutOtherDevices": .bool(signOutOtherDevices),
        ])).revokedDevices
    }

    public func startTotpEnrollment() async throws -> TotpEnrollment {
        try await post(TotpEnrollment.self, "/api/account/totp/start")
    }

    /// Switches to the new authenticator once `code` from it checks out.
    @discardableResult
    public func finishTotpEnrollment(id: String, code: String,
                                     signOutOtherDevices: Bool) async throws -> [String] {
        try await post(RevokedDevices.self, "/api/account/totp/finish", body: .object([
            "enrollmentId": .string(id),
            "code": .string(code),
            "signOutOtherDevices": .bool(signOutOtherDevices),
        ])).revokedDevices
    }

    /// Replaces the backup codes. The new ones are shown once.
    public func regenerateBackupCodes() async throws -> [String] {
        struct Codes: Decodable { var backupCodes: [String] }
        return try await post(Codes.self, "/api/account/backup-codes").backupCodes
    }

    /// Revokes every device but this one and returns their ids.
    public func signOutOtherDevices() async throws -> [String] {
        try await post(RevokedDevices.self, "/api/account/sign-out-others").revokedDevices
    }

    // MARK: Vault

    /// Opens the vault with its passphrase. Needs `admin`, not a fresh check.
    public func unlockVault(passphrase: String) async throws {
        try await send("POST", "/api/vault/unlock", body: .object(["passphrase": .string(passphrase)]))
    }

    public func unlockVault(recoveryKey: String) async throws {
        try await send("POST", "/api/vault/unlock/recovery", body: .object(["recoveryKey": .string(recoveryKey)]))
    }
}
