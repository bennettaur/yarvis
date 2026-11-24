import Foundation
import Observation
import YarvisClient

enum SettingsTab: String, CaseIterable, Identifiable {
    case connection, approvals, account, devices

    var id: String { rawValue }

    var title: String {
        switch self {
        case .connection: return "Connection"
        case .approvals: return "Approvals"
        case .account: return "Account"
        case .devices: return "Devices"
        }
    }

    var symbol: String {
        switch self {
        case .connection: return "network"
        case .approvals: return "checkmark.seal"
        case .account: return "person.crop.circle"
        case .devices: return "laptopcomputer.and.iphone"
        }
    }
}

/// The Settings page: devices, the account, and the vault.
@MainActor @Observable
final class SettingsModel {
    private unowned let app: AppModel
    private let client: YarvisClient

    var tab: SettingsTab = .connection

    // MARK: Vault

    /// `absent`, `uninitialized`, `locked` or `unlocked`; nil until read.
    private(set) var vaultState: String?
    var vaultPassphrase = ""
    var recoveryKey = ""
    var useRecoveryKey = false
    private(set) var vaultBusy = false
    private(set) var vaultError: String?

    /// True while the server's vault is locked (or has never been set up),
    /// which keeps the sidecar, and so chat and workspaces, down.
    var vaultNeedsUnlock: Bool { SettingsRules.vaultBlocksApp(vaultState) }

    // MARK: Devices

    private(set) var me: Device?
    private(set) var devices: [DeviceRecord] = []
    private(set) var devicesLoaded = false
    private(set) var devicesError: String?
    var revoking: DeviceRecord?
    private(set) var busyDevice: String?

    var tokenName = ""
    var tokenScopes: Set<Scope> = [.read, .chat]
    private(set) var tokenBusy = false
    private(set) var tokenError: String?
    /// The token just made. It's shown once, then dropped.
    private(set) var mintedToken: String?

    // MARK: Account

    private(set) var backupCodesLeft: Int?
    var signOutOthers = false
    var currentPassphrase = ""
    var newPassphrase = ""
    private(set) var accountBusy = false
    private(set) var accountError: String?
    private(set) var accountNotice: String?
    private(set) var enrollment: TotpEnrollment?
    var enrollmentCode = ""
    /// New backup codes, shown once.
    private(set) var newBackupCodes: [String]?

    private var vaultTask: Task<Void, Never>?

    init(app: AppModel, client: YarvisClient) {
        self.app = app
        self.client = client
        refreshVault()
        reloadDevices()
    }

    func stop() {
        vaultTask?.cancel()
    }

    var isAdmin: Bool { (me ?? app.device)?.has(.admin) ?? false }
    var thisDevice: Device? { me ?? app.device }
    var serverURL: String { client.baseURL.absoluteString }
    var approvals: [Approval] { app.attention?.approvals ?? [] }

    func answer(_ approval: Approval, approve: Bool) {
        app.attention?.answer(approval, approve: approve)
    }

    func signOut() {
        Task { await app.signOut() }
    }

    func openInBrowser() {
        app.openInBrowser()
    }

    // MARK: Events

    func handle(_ event: ServerEvent) {
        switch event.kind {
        case "vault.locked", "vault.unlocked":
            refreshVault()
        case "device.created", "device.revoked":
            reloadDevices()
        case "account.changed", "account.reset", "account.backup_code_used":
            reloadAccount()
        case "approval.requested", "approval.answered":
            app.attention?.reloadApprovals()
        default:
            break
        }
    }

    func resync() {
        refreshVault()
        reloadDevices()
    }

    /// Shows a Settings tab by the web's key. Only `devices` has its own
    /// page here; any other key shows the default tab.
    func open(tab key: String) {
        tab = key == "devices" ? .devices : .connection
    }

    // MARK: Vault

    /// Reads the vault state from the unauthenticated status route, which
    /// answers even while the vault is locked.
    func refreshVault() {
        vaultTask?.cancel()
        let base = client.baseURL
        vaultTask = Task {
            guard let status = try? await YarvisClient.status(baseURL: base), !Task.isCancelled else { return }
            applyVault(status.vault)
        }
    }

    private func applyVault(_ state: String?) {
        let wasBlocked = vaultNeedsUnlock
        vaultState = state
        if wasBlocked, !vaultNeedsUnlock {
            // The sidecar starts after the unlock, so these pages had nothing to load before.
            app.chat?.resync()
            app.workspaces?.resync()
            app.attention?.reload()
            reloadDevices()
        }
    }

    func unlockVault() async {
        guard !vaultBusy else { return }
        vaultBusy = true
        vaultError = nil
        defer { vaultBusy = false }
        do {
            if useRecoveryKey {
                try await client.unlockVault(recoveryKey: recoveryKey.trimmingCharacters(in: .whitespacesAndNewlines))
            } else {
                try await client.unlockVault(passphrase: vaultPassphrase)
            }
            vaultPassphrase = ""
            recoveryKey = ""
            applyVault("unlocked")
        } catch YarvisError.http(status: 409, let error, _) where error == "the vault is already unlocked" {
            applyVault("unlocked")
        } catch {
            vaultError = error.localizedDescription
        }
    }

    // MARK: Devices

    func reloadDevices() {
        Task { await loadDevices() }
    }

    private func loadDevices() async {
        do {
            me = try await client.me()
            if isAdmin {
                devices = try await client.devices()
                backupCodesLeft = try await client.backupCodesLeft()
            } else {
                devices = []
                backupCodesLeft = nil
            }
            devicesError = nil
        } catch YarvisError.unauthorized {
            return
        } catch {
            devicesError = error.localizedDescription
        }
        devicesLoaded = true
    }

    private func reloadAccount() {
        guard isAdmin else { return }
        Task { backupCodesLeft = try? await client.backupCodesLeft() }
    }

    /// Account changes need admin, so the tab is hidden without it.
    var tabs: [SettingsTab] { SettingsTab.allCases.filter { $0 != .account || isAdmin } }

    var activeDevices: [DeviceRecord] { SettingsRules.active(devices) }

    func revoke(_ device: DeviceRecord) async {
        busyDevice = device.deviceId
        devicesError = nil
        defer { busyDevice = nil }
        do {
            _ = try await app.withFreshCode { [client] in try await client.revokeDevice(id: device.deviceId) }
        } catch {
            devicesError = error.localizedDescription
            return
        }
        if device.current || device.deviceId == thisDevice?.deviceId {
            await app.signOut()
        } else {
            await loadDevices()
        }
    }

    func mintToken() async {
        if let problem = SettingsRules.tokenProblem(name: tokenName, scopes: tokenScopes) {
            tokenError = problem
            return
        }
        tokenBusy = true
        tokenError = nil
        defer { tokenBusy = false }
        let name = tokenName.trimmingCharacters(in: .whitespacesAndNewlines)
        let scopes = mintableScopes.filter(tokenScopes.contains)
        do {
            let minted = try await app.withFreshCode { [client] in try await client.mintToken(name: name, scopes: scopes) }
            mintedToken = minted.token
            tokenName = ""
            await loadDevices()
        } catch {
            tokenError = error.localizedDescription
        }
    }

    func dismissToken() {
        mintedToken = nil
    }

    // MARK: Account

    var canChangePassphrase: Bool {
        SettingsRules.canChangePassphrase(current: currentPassphrase, new: newPassphrase)
    }

    /// Runs one account change behind the fresh-code prompt and shows its outcome.
    private func account<T: Sendable>(_ action: @escaping @Sendable (YarvisClient) async throws -> T,
                                      done: (T) -> String?) async {
        accountBusy = true
        accountError = nil
        accountNotice = nil
        defer { accountBusy = false }
        do {
            let result = try await app.withFreshCode { [client] in try await action(client) }
            accountNotice = done(result)
            reloadAccount()
            reloadDevices()
        } catch {
            accountError = error.localizedDescription
        }
    }

    func changePassphrase() async {
        guard canChangePassphrase else { return }
        let (current, new, others) = (currentPassphrase, newPassphrase, signOutOthers)
        await account({ try await $0.changePassphrase(current: current, new: new, signOutOtherDevices: others) }) {
            currentPassphrase = ""
            newPassphrase = ""
            return SettingsRules.passphraseChanged(otherDevicesSignedOut: $0.count)
        }
    }

    func startEnrollment() async {
        await account({ try await $0.startTotpEnrollment() }) {
            enrollment = $0
            enrollmentCode = ""
            return nil
        }
    }

    func cancelEnrollment() {
        enrollment = nil
        enrollmentCode = ""
    }

    func finishEnrollment() async {
        guard let enrollment else { return }
        let (code, others) = (enrollmentCode.trimmingCharacters(in: .whitespaces), signOutOthers)
        await account({ try await $0.finishTotpEnrollment(id: enrollment.enrollmentId, code: code,
                                                          signOutOtherDevices: others) }) { _ in
            cancelEnrollment()
            return "The new authenticator is in use."
        }
    }

    func makeBackupCodes() async {
        await account({ try await $0.regenerateBackupCodes() }) {
            newBackupCodes = $0
            return nil
        }
    }

    func dismissBackupCodes() {
        newBackupCodes = nil
    }

    func signOutOtherDevices() async {
        await account({ try await $0.signOutOtherDevices() }) { SettingsRules.devicesSignedOut($0.count) }
    }
}
