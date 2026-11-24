import Foundation
import Testing
@testable import YarvisClient

private func client(_ status: Int = 200, _ body: String) -> (YarvisClient, String) {
    let (session, id) = StubProtocol.session { _, _ in (status, json(body)) }
    return (YarvisClient(baseURL: base, token: "tok", session: session), id)
}

private func sent(_ id: String) throws -> (method: String?, path: String?, body: JSONValue?) {
    let (req, body) = try #require(StubProtocol.recorded(id).first)
    return (req.httpMethod, req.url?.path, bodyJSON(body))
}

@Suite struct DevicesAPITests {
    @Test func listsDevicesIncludingRevokedOnes() async throws {
        let (c, id) = client(200, """
        [{"deviceId":"d1","name":"Mac","kind":"login","scopes":["read","admin","future"],"createdBy":null,
          "userAgent":"UA","createdAt":1,"lastSeenAt":null,"verifiedAt":3,"revokedAt":null,"current":true},
         {"deviceId":"d2","name":"CI","kind":"token","scopes":["read"],"createdBy":"d1","userAgent":null,
          "createdAt":2,"lastSeenAt":9,"verifiedAt":null,"revokedAt":10,"current":false}]
        """)
        let list = try await c.devices()
        #expect(list.map(\.deviceId) == ["d1", "d2"])
        #expect(list[0].scopes.contains("future"))
        #expect(list[0].current && !list[0].isRevoked && !list[0].isToken)
        #expect(list[1].isRevoked && list[1].isToken)
        let r = try sent(id)
        #expect(r.method == "GET" && r.path == "/api/devices")
    }

    @Test func revokesOneDeviceByItsEncodedId() async throws {
        let (c, id) = client(200, #"{"revokedAt":42}"#)
        #expect(try await c.revokeDevice(id: "a/b") == 42)
        let (req, _) = try #require(StubProtocol.recorded(id).first)
        #expect(req.httpMethod == "DELETE")
        #expect(req.url?.absoluteString == "https://yarvis.example.ts.net/api/devices/a%2Fb")
    }

    @Test func revokeMapsReauthAndMissingDevice() async throws {
        let (c, _) = client(403, #"{"error":"reauth_required"}"#)
        await #expect(throws: YarvisError.reauthRequired) { try await c.revokeDevice(id: "d") }
        let (gone, _) = client(404, #"{"error":"no such active device"}"#)
        await #expect(throws: YarvisError.http(status: 404, error: "no such active device", detail: nil)) {
            try await gone.revokeDevice(id: "d")
        }
    }

    @Test func mintsATokenWithNameAndScopes() async throws {
        let (c, id) = client(200, #"{"token":"secret","device":{"deviceId":"d3","name":"Work","scopes":["read","chat"]}}"#)
        let minted = try await c.mintToken(name: "Work", scopes: [.read, .chat])
        #expect(minted.token == "secret" && minted.device.deviceId == "d3")
        let r = try sent(id)
        #expect(r.method == "POST" && r.path == "/api/devices/tokens")
        #expect(r.body == .object(["name": .string("Work"), "scopes": .array([.string("read"), .string("chat")])]))
    }

    @Test func mintingShowsTheServersRefusalDetail() async throws {
        let (c, _) = client(400, #"{"error":"a token made here can't have admin","detail":"run `yarvis-server device add` on the server instead"}"#)
        do {
            _ = try await c.mintToken(name: "x", scopes: [.admin])
            Issue.record("expected a refusal")
        } catch let error as YarvisError {
            #expect(error.errorDescription?.contains("yarvis-server device add") == true)
        }
    }

    @Test func readsBackupCodesLeft() async throws {
        let (c, id) = client(200, #"{"backupCodesLeft":7}"#)
        #expect(try await c.backupCodesLeft() == 7)
        let r = try sent(id)
        #expect(r.method == "GET" && r.path == "/api/account")
    }
}

@Suite struct AccountAPITests {
    @Test func changesThePassphrase() async throws {
        let (c, id) = client(200, #"{"revokedDevices":["a","b"]}"#)
        let revoked = try await c.changePassphrase(current: "old", new: "new passphrase!", signOutOtherDevices: true)
        #expect(revoked == ["a", "b"])
        let r = try sent(id)
        #expect(r.method == "POST" && r.path == "/api/account/passphrase")
        #expect(r.body == .object([
            "currentPassphrase": .string("old"), "newPassphrase": .string("new passphrase!"),
            "signOutOtherDevices": .bool(true),
        ]))
    }

    @Test func aWrongCurrentPassphraseIsAPlain403() async throws {
        let (c, _) = client(403, #"{"error":"that isn't the current passphrase"}"#)
        await #expect(throws: YarvisError.http(status: 403, error: "that isn't the current passphrase", detail: nil)) {
            try await c.changePassphrase(current: "x", new: "y", signOutOtherDevices: false)
        }
    }

    @Test func startsAnAuthenticatorChange() async throws {
        let (c, id) = client(200, #"{"enrollmentId":"e1","secret":"ABC","otpauthUri":"otpauth://totp/x","qrSvg":"<svg/>"}"#)
        let e = try await c.startTotpEnrollment()
        #expect(e == TotpEnrollment(enrollmentId: "e1", secret: "ABC", otpauthUri: "otpauth://totp/x", qrSvg: "<svg/>"))
        let r = try sent(id)
        #expect(r.method == "POST" && r.path == "/api/account/totp/start" && r.body == .object([:]))
    }

    @Test func finishesAnAuthenticatorChange() async throws {
        let (c, id) = client(200, #"{"revokedDevices":[]}"#)
        _ = try await c.finishTotpEnrollment(id: "e1", code: "123456", signOutOtherDevices: false)
        let r = try sent(id)
        #expect(r.path == "/api/account/totp/finish")
        #expect(r.body == .object([
            "enrollmentId": .string("e1"), "code": .string("123456"), "signOutOtherDevices": .bool(false),
        ]))
    }

    @Test func aWrongAuthenticatorCodeIsAPlain403() async throws {
        let (c, _) = client(403, #"{"error":"wrong code"}"#)
        await #expect(throws: YarvisError.http(status: 403, error: "wrong code", detail: nil)) {
            try await c.finishTotpEnrollment(id: "e", code: "0", signOutOtherDevices: false)
        }
    }

    @Test func makesNewBackupCodes() async throws {
        let (c, id) = client(200, #"{"backupCodes":["aaaa-bbbb","cccc-dddd"]}"#)
        #expect(try await c.regenerateBackupCodes() == ["aaaa-bbbb", "cccc-dddd"])
        let r = try sent(id)
        #expect(r.method == "POST" && r.path == "/api/account/backup-codes")
    }

    @Test func signsOutOtherDevices() async throws {
        let (c, id) = client(200, #"{"revokedDevices":["x"]}"#)
        #expect(try await c.signOutOtherDevices() == ["x"])
        let r = try sent(id)
        #expect(r.method == "POST" && r.path == "/api/account/sign-out-others")
    }

    @Test func anUnreadableAnswerIsABadResponse() async throws {
        let (c, _) = client(200, #"{"nope":1}"#)
        await #expect(throws: YarvisError.badResponse) { try await c.signOutOtherDevices() }
    }
}

@Suite struct VaultAPITests {
    @Test func readsTheVaultStatus() async throws {
        let (c, id) = client(200, #"{"state":"locked","wrappers":[{"id":"w1","label":"Passphrase","kind":"passphrase"}]}"#)
        let s = try await c.vaultStatus()
        #expect(s.state == "locked" && s.wrappers.first?.label == "Passphrase")
        let r = try sent(id)
        #expect(r.method == "GET" && r.path == "/api/vault/status")
    }

    @Test func unlocksWithThePassphrase() async throws {
        let (c, id) = client(200, #"{"state":"unlocked"}"#)
        try await c.unlockVault(passphrase: "vault pass")
        let r = try sent(id)
        #expect(r.method == "POST" && r.path == "/api/vault/unlock")
        #expect(r.body == .object(["passphrase": .string("vault pass")]))
    }

    @Test func unlocksWithTheRecoveryKey() async throws {
        let (c, id) = client(200, #"{"state":"unlocked"}"#)
        try await c.unlockVault(recoveryKey: "key")
        let r = try sent(id)
        #expect(r.path == "/api/vault/unlock/recovery")
        #expect(r.body == .object(["recoveryKey": .string("key")]))
    }

    @Test func keepsTheWaitMessage() async throws {
        let (c, _) = client(429, #"{"error":"wait before trying again","detail":"try again in 30 seconds"}"#)
        await #expect(throws: YarvisError.http(status: 429, error: "wait before trying again",
                                               detail: "try again in 30 seconds")) {
            try await c.unlockVault(passphrase: "x")
        }
    }

    @Test func aRefusalIsA403() async throws {
        let (c, _) = client(403, #"{"error":"that doesn't open the vault"}"#)
        await #expect(throws: YarvisError.http(status: 403, error: "that doesn't open the vault", detail: nil)) {
            try await c.unlockVault(recoveryKey: "x")
        }
    }

    @Test func aMissingVaultRouteIsA404() async throws {
        let (c, _) = client(404, #"{"error":"not found"}"#)
        await #expect(throws: YarvisError.http(status: 404, error: "not found", detail: nil)) {
            try await c.vaultStatus()
        }
    }
}

@Suite struct SettingsRulesTests {
    private func record(kind: String = "login", scopes: [String] = ["read"], lastSeen: Int64? = nil,
                        revoked: Int64? = nil) -> DeviceRecord {
        DeviceRecord(deviceId: "d", name: "n", kind: kind, scopes: scopes, createdBy: nil, userAgent: nil,
                     createdAt: 0, lastSeenAt: lastSeen, verifiedAt: nil, revokedAt: revoked, current: false)
    }

    @Test func aTokenNeedsANameAndAScope() {
        #expect(SettingsRules.tokenProblem(name: "  ", scopes: [.read]) == "Give the token a name, so you can tell it apart later.")
        #expect(SettingsRules.tokenProblem(name: "CI", scopes: []) == "Pick at least one scope.")
        #expect(SettingsRules.tokenProblem(name: "CI", scopes: [.read]) == nil)
    }

    @Test func aNewPassphraseNeedsTwelveCharacters() {
        #expect(!SettingsRules.canChangePassphrase(current: "", new: "123456789012"))
        #expect(!SettingsRules.canChangePassphrase(current: "old", new: "12345678901"))
        #expect(SettingsRules.canChangePassphrase(current: "old", new: "123456789012"))
    }

    @Test func describesADevice() {
        let line = SettingsRules.deviceDetail(record(kind: "token", scopes: ["read", "chat"])) { _ in "" }
        #expect(line == "Token · read, chat · last seen never")
        let seen = SettingsRules.deviceDetail(record(lastSeen: 1000)) { "at \($0.timeIntervalSince1970)" }
        #expect(seen == "Signed in · read · last seen at 1.0")
    }

    @Test func hidesRevokedDevices() {
        let list = [record(), record(revoked: 5)]
        #expect(SettingsRules.active(list).count == 1)
    }

    @Test func countsReadAsTheWebDoes() {
        #expect(SettingsRules.devicesSignedOut(1) == "Signed out 1 other device.")
        #expect(SettingsRules.devicesSignedOut(2) == "Signed out 2 other devices.")
        #expect(SettingsRules.passphraseChanged(otherDevicesSignedOut: 0) == "Passphrase changed. 0 other devices signed out.")
        #expect(SettingsRules.backupCodesLeft(1) == "1 backup code left.")
    }

    @Test func onlyLockedAndUninitializedBlockTheApp() {
        #expect(SettingsRules.vaultBlocksApp("locked"))
        #expect(SettingsRules.vaultBlocksApp("uninitialized"))
        #expect(!SettingsRules.vaultBlocksApp("unlocked"))
        #expect(!SettingsRules.vaultBlocksApp("absent"))
        #expect(!SettingsRules.vaultBlocksApp(nil))
    }
}
