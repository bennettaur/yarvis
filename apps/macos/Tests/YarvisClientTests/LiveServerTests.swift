import CryptoKit
import Foundation
import Testing
@testable import YarvisClient

/// Runs against a real `yarvis-server` when `YARVIS_E2E_URL` and
/// `YARVIS_E2E_TOKEN` are set (a token from `yarvis-server device add` with
/// at least `read,terminal`). `YARVIS_E2E_READ_TOKEN`, a `read`-only token, adds the
/// scope check. The sidecar can be off: these cover only the server's own
/// routes. See `apps/macos/README.md`.
enum Live {
    static let env = ProcessInfo.processInfo.environment
    static let url = env["YARVIS_E2E_URL"].flatMap { try? parseServerURL($0) }
    static let token = env["YARVIS_E2E_TOKEN"]
    static let readToken = env["YARVIS_E2E_READ_TOKEN"]
    static let enabled = url != nil && token != nil
}

@Suite(.enabled(if: Live.enabled), .timeLimit(.minutes(1)))
struct LiveServerTests {
    let url = Live.url!
    let token = Live.token!

    @Test func readsThisDevice() async throws {
        let me = try await YarvisClient(baseURL: url, token: token).me()
        #expect(me.has(.terminal))
    }

    @Test func aBadTokenGets401OverHTTPAnd4401OverWebSocket() async throws {
        let client = YarvisClient(baseURL: url, token: "not-a-token")
        await #expect(throws: YarvisError.unauthorized) { try await client.me() }
        let events = EventStream(baseURL: url, token: "not-a-token")
        await events.start()
        #expect(await collect(events.updates) == [.signedOut])
    }

    @Test(.enabled(if: Live.readToken != nil)) func aTerminalWithoutTheScopeGets4403() async throws {
        let pty = PtyConnection(baseURL: url, token: Live.readToken!, sessionId: "e2e/\(UUID())", cols: 80, rows: 24)
        await pty.start()
        #expect(await collect(pty.updates) == [.refused(code: 4403)])
    }

    /// Spawns a shell, types into it, and watches its exit arrive both on the
    /// PTY socket and as a `pty.exited` event.
    @Test func aShellRunsAndItsExitIsAnEvent() async throws {
        let id = "e2e/\(UUID().uuidString)"
        // From the start of the log, so the exit can't land before the socket is up.
        let events = EventStream(baseURL: url, token: token, since: 0)
        await events.start()
        let exited = Task {
            for await update in events.updates {
                if case .event(let e) = update, e.kind == "pty.exited", e.data["id"] == .string(id) {
                    return e.data["code"]
                }
            }
            return nil
        }

        let pty = PtyConnection(baseURL: url, token: token, sessionId: id, cols: 100, rows: 30,
                                cwd: FileManager.default.temporaryDirectory.path)
        await pty.start()
        var screen = ""
        var typed = false
        var exitCode: Int?? = nil
        for await update in pty.updates {
            switch update {
            case .output(let bytes):
                screen += String(decoding: bytes, as: UTF8.self)
                if !typed {
                    typed = true
                    await pty.send(input: Data("echo yarvis-$((40+2)); exit 3\n".utf8))
                }
            case .exit(let code):
                exitCode = .some(code)
            default:
                break
            }
        }
        #expect(screen.contains("yarvis-42"))
        #expect(exitCode == .some(3))
        #expect(await exited.value == .number(3))
        await events.stop()
    }
}

/// Signs in to a real server set up with `YARVIS_E2E_PASSPHRASE` and the
/// base32 `YARVIS_E2E_TOTP_SECRET` its setup printed.
@Suite(.enabled(if: Live.url != nil && Live.env["YARVIS_E2E_PASSPHRASE"] != nil
    && Live.env["YARVIS_E2E_TOTP_SECRET"] != nil), .timeLimit(.minutes(1)))
struct LiveSignInTests {
    let url = Live.url!
    let passphrase = Live.env["YARVIS_E2E_PASSPHRASE"]!
    let secret = Live.env["YARVIS_E2E_TOTP_SECRET"]!

    @Test func signsInAndAWrongCodeKeepsTheDeviceSignedIn() async throws {
        await #expect(throws: YarvisError.unauthorized) {
            try await YarvisClient.signIn(baseURL: url, SignInRequest(passphrase: "wrong passphrase!!", code: "000000",
                                                                      deviceName: "e2e"))
        }
        // The server refuses a code already used, so the next step's code is
        // the fallback when this step's was spent by an earlier run.
        let step = Int64(Date().timeIntervalSince1970) / 30
        var signedIn: SignedIn?
        for s in [step, step + 1] where signedIn == nil {
            signedIn = try? await YarvisClient.signIn(baseURL: url, SignInRequest(
                passphrase: passphrase, code: totp(secret: secret, step: s), deviceName: "macOS e2e"))
        }
        let device = try #require(signedIn).device
        #expect(Set(device.scopes) == Set(Scope.allCases))

        let lost = Counter()
        let client = YarvisClient(baseURL: url, token: signedIn!.token, onUnauthorized: { lost.bump() })
        #expect(try await client.me().deviceId == device.deviceId)
        let refusal = await #expect(throws: YarvisError.self) { try await client.reverify(code: "000000") }
        guard case .http(403, "wrong code", _)? = refusal else {
            Issue.record("expected 403 wrong code, got \(String(describing: refusal))")
            return
        }
        #expect(lost.value == 0)
    }
}

/// RFC 6238 with the server's parameters: HMAC-SHA1, 6 digits, 30-second steps.
func totp(secret: String, step: Int64) -> String {
    let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
    var bits = 0, value = 0
    var key = [UInt8]()
    for c in secret.uppercased() where c != "=" {
        guard let i = alphabet.firstIndex(of: c) else { continue }
        value = (value << 5) | i
        bits += 5
        if bits >= 8 {
            key.append(UInt8((value >> (bits - 8)) & 0xff))
            bits -= 8
        }
    }
    var counter = UInt64(step).bigEndian
    let mac = Array(HMAC<Insecure.SHA1>.authenticationCode(for: Data(bytes: &counter, count: 8),
                                                         using: SymmetricKey(data: key)))
    let o = Int(mac[mac.count - 1] & 0x0f)
    let n = (UInt32(mac[o] & 0x7f) << 24) | (UInt32(mac[o + 1]) << 16) | (UInt32(mac[o + 2]) << 8) | UInt32(mac[o + 3])
    return String(format: "%06d", n % 1_000_000)
}
