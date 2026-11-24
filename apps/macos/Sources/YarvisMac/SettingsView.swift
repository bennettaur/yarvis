import AppKit
import SwiftUI
import YarvisClient

struct SettingsView: View {
    @Bindable var model: SettingsModel

    var body: some View {
        HStack(spacing: 0) {
            List(model.tabs, selection: $model.tab) { tab in
                Label(tab.title, systemImage: tab.symbol).tag(tab)
            }
            .frame(width: 180)
            Divider()
            ScrollView {
                Group {
                    switch model.tab {
                    case .connection: ConnectionSection(model: model)
                    case .approvals: ApprovalsSection(model: model)
                    case .account: AccountSection(model: model)
                    case .devices: DevicesSection(model: model)
                    }
                }
                .frame(maxWidth: 640, alignment: .leading)
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct ConnectionSection: View {
    let model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connection").font(.title2.bold())
            LabeledContent("Server", value: model.serverURL).textSelection(.enabled)
            if let device = model.thisDevice {
                LabeledContent("This device", value: device.name)
                LabeledContent("Scopes", value: device.scopes.map(\.rawValue).joined(separator: ", "))
            }
            HStack {
                Button("Open in Browser") { model.openInBrowser() }
                Button("Sign Out", role: .destructive) { model.signOut() }
            }
        }
    }
}

private struct ApprovalsSection: View {
    let model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Approvals").font(.title2.bold())
            if model.approvals.isEmpty {
                Text("Nothing is waiting.").foregroundStyle(.secondary)
            }
            ForEach(model.approvals) { approval in
                HStack {
                    VStack(alignment: .leading) {
                        Text(approval.summary)
                        Text(approval.kind).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Group {
                        Button("Deny") { model.answer(approval, approve: false) }
                        Button("Approve") { model.answer(approval, approve: true) }.buttonStyle(.borderedProminent)
                    }
                    .armedAfterAppearing(id: approval.id)
                }
                Divider()
            }
        }
    }
}

private struct DevicesSection: View {
    @Bindable var model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Devices").font(.title2.bold())
            if let device = model.thisDevice {
                Text("This device: \(device.name) (\(device.scopes.map(\.rawValue).joined(separator: ", ")))")
                    .foregroundStyle(.secondary)
            }
            if !model.isAdmin {
                Text("Managing devices needs the admin scope.").foregroundStyle(.secondary)
            } else {
                deviceList
                Divider()
                PairDeviceForm(model: model)
            }
            if let error = model.devicesError {
                Text(error).foregroundStyle(.red).textSelection(.enabled)
            }
        }
        .confirmationDialog(
            "Revoke \(model.revoking?.name ?? "this device")?",
            isPresented: Binding(get: { model.revoking != nil }, set: { if !$0 { model.revoking = nil } }),
            presenting: model.revoking
        ) { device in
            Button("Revoke", role: .destructive) { Task { await model.revoke(device) } }
        } message: { device in
            Text(device.current
                 ? "This device will be signed out and you'll need to sign in again."
                 : "It will be signed out and its token stops working.")
        }
    }

    @ViewBuilder
    private var deviceList: some View {
        if model.activeDevices.isEmpty {
            Text(model.devicesLoaded ? "No devices." : "Loading…").foregroundStyle(.secondary)
        }
        ForEach(model.activeDevices) { device in
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(device.name).bold()
                        if device.current {
                            Text("this device")
                                .font(.caption)
                                .padding(.horizontal, 6)
                                .background(.quaternary, in: Capsule())
                        }
                    }
                    Text(SettingsRules.deviceDetail(device) { $0.formatted(date: .abbreviated, time: .shortened) })
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Revoke", role: .destructive) { model.revoking = device }
                    .disabled(model.busyDevice != nil)
            }
            Divider()
        }
    }
}

private struct PairDeviceForm: View {
    @Bindable var model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Pair a device with a token").font(.headline)
            if let token = model.mintedToken {
                Text("Copy this token now. It won't be shown again.")
                Text(token).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                HStack {
                    Button("Copy") { copyToPasteboard(token, secret: true) }
                    Button("Done") { model.dismissToken() }
                }
            } else {
                TextField("Name", text: $model.tokenName, prompt: Text("Work laptop"))
                    .textFieldStyle(.roundedBorder)
                ForEach(mintableScopes, id: \.self) { scope in
                    Toggle(isOn: Binding(
                        get: { model.tokenScopes.contains(scope) },
                        set: { on in
                            if on { model.tokenScopes.insert(scope) } else { model.tokenScopes.remove(scope) }
                        }
                    )) {
                        Text("\(scope.rawValue) — \(scope.summary)")
                    }
                }
                Button("Create token") { Task { await model.mintToken() } }
                    .disabled(model.tokenBusy)
                if let error = model.tokenError {
                    Text(error).foregroundStyle(.red).textSelection(.enabled)
                }
            }
        }
    }
}

private struct AccountSection: View {
    @Bindable var model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Account").font(.title2.bold())
            do {
                if let left = model.backupCodesLeft {
                    Text(SettingsRules.backupCodesLeft(left))
                }
                Toggle("Also sign out every other device when changing the passphrase or authenticator",
                       isOn: $model.signOutOthers)
                passphrase
                Divider()
                authenticator
                Divider()
                backupCodes
                Divider()
                Button("Sign out all other devices") { Task { await model.signOutOtherDevices() } }
                    .disabled(model.accountBusy)
                if let notice = model.accountNotice { Text(notice).foregroundStyle(.green) }
                if let error = model.accountError {
                    Text(error).foregroundStyle(.red).textSelection(.enabled)
                }
            }
        }
    }

    private var passphrase: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Change passphrase").font(.headline)
            SecureField("Current passphrase", text: $model.currentPassphrase).textFieldStyle(.roundedBorder)
            SecureField("New passphrase (12 or more characters)", text: $model.newPassphrase)
                .textFieldStyle(.roundedBorder)
            Button("Change passphrase") { Task { await model.changePassphrase() } }
                .disabled(!model.canChangePassphrase || model.accountBusy)
        }
    }

    @ViewBuilder
    private var authenticator: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Authenticator").font(.headline)
            if let enrollment = model.enrollment {
                if let image = qrImage(enrollment.qrSvg) {
                    Image(nsImage: image).resizable().interpolation(.none).frame(width: 180, height: 180)
                } else {
                    Text(enrollment.otpauthUri).font(.caption).textSelection(.enabled)
                }
                Text("Secret: \(enrollment.secret)")
                    .font(.system(.body, design: .monospaced)).textSelection(.enabled)
                TextField("Code from the new authenticator", text: $model.enrollmentCode)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await model.finishEnrollment() } }
                HStack {
                    Button("Confirm") { Task { await model.finishEnrollment() } }
                        .disabled(model.enrollmentCode.isEmpty || model.accountBusy)
                    Button("Cancel") { model.cancelEnrollment() }
                }
            } else {
                Button("Set up a new authenticator") { Task { await model.startEnrollment() } }
                    .disabled(model.accountBusy)
            }
        }
    }

    @ViewBuilder
    private var backupCodes: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Backup codes").font(.headline)
            if let codes = model.newBackupCodes {
                Text("Save these now. They won't be shown again.")
                Text(codes.joined(separator: "\n"))
                    .font(.system(.body, design: .monospaced)).textSelection(.enabled)
                HStack {
                    Button("Copy") { copyToPasteboard(codes.joined(separator: "\n"), secret: true) }
                    Button("Done") { model.dismissBackupCodes() }
                }
            } else {
                Button("Make new backup codes") { Task { await model.makeBackupCodes() } }
                    .disabled(model.accountBusy)
            }
        }
    }

    /// macOS 14 reads SVG through `NSImage`; nil falls back to the secret and URI.
    private func qrImage(_ svg: String?) -> NSImage? {
        svg.flatMap { NSImage(data: Data($0.utf8)) }.flatMap { $0.isValid ? $0 : nil }
    }
}

/// Shown instead of the app while the server's vault is locked.
struct VaultUnlockView: View {
    @Bindable var model: SettingsModel

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "lock.fill").font(.largeTitle)
            if model.vaultState == "uninitialized" {
                Text("The server's vault has no passphrase yet.").font(.headline)
                Text("Run `yarvis-server vault init` on the server, then come back.")
                    .foregroundStyle(.secondary)
                Button("Check again") { model.refreshVault() }
            } else {
                Text("The server's vault is locked.").font(.headline)
                if model.useRecoveryKey {
                    SecureField("Recovery key", text: $model.recoveryKey)
                        .onSubmit { Task { await model.unlockVault() } }
                } else {
                    SecureField("Vault passphrase", text: $model.vaultPassphrase)
                        .onSubmit { Task { await model.unlockVault() } }
                }
                Button("Unlock") { Task { await model.unlockVault() } }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.vaultBusy)
                Button(model.useRecoveryKey ? "Use the vault passphrase" : "Use the recovery key") {
                    model.useRecoveryKey.toggle()
                }
                .buttonStyle(.link)
                if let error = model.vaultError {
                    Text(error).foregroundStyle(.red).textSelection(.enabled)
                }
            }
            Button("Sign Out") { model.signOut() }.buttonStyle(.link)
        }
        .textFieldStyle(.roundedBorder)
        .frame(width: 320)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
