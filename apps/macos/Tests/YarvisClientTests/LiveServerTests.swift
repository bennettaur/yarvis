import Foundation
import Testing
@testable import YarvisClient

/// Runs against a real `yarvis-server` when `YARVIS_E2E_URL` and
/// `YARVIS_E2E_TOKEN` are set (a token from `yarvis-server device add` with
/// `read,terminal`). `YARVIS_E2E_READ_TOKEN`, a `read`-only token, adds the
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
        #expect(await collect(pty.updates) == [.closed(code: 4403)])
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
