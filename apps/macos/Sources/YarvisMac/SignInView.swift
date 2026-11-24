import SwiftUI
import YarvisClient

struct SignInView: View {
    @Environment(AppModel.self) private var app
    @State private var server = ""
    @State private var passphrase = ""
    @State private var code = ""
    @State private var useBackupCode = false
    @State private var deviceName = Host.current().localizedName ?? "Mac"
    @State private var errorMessage: String?
    @State private var busy = false
    @State private var needsSetup = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Sign in to Yarvis").font(.title2.bold())
            if let reason = app.signOutReason {
                Text(reason).foregroundStyle(.secondary)
            }
            Form {
                TextField("Server", text: $server, prompt: Text("https://yarvis.example.ts.net"))
                    .onSubmit { Task { await checkStatus() } }
                SecureField("Passphrase", text: $passphrase)
                TextField(useBackupCode ? "Backup code" : "Authenticator code", text: $code)
                Toggle("Use a backup code", isOn: $useBackupCode)
                TextField("Device name", text: $deviceName)
            }
            .formStyle(.grouped)
            if needsSetup {
                Text("This server hasn't been set up yet. Finish setup in the web UI, then sign in here.")
                    .foregroundStyle(.orange)
                Button("Open the web UI to set up") {
                    if let url = try? parseServerURL(server) { NSWorkspace.shared.open(url) }
                }
            }
            if let errorMessage {
                Text(errorMessage).foregroundStyle(.red).textSelection(.enabled)
            }
            HStack {
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button("Sign In") { Task { await signIn() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || server.isEmpty || passphrase.isEmpty || code.isEmpty || deviceName.isEmpty)
            }
        }
        .padding(28)
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { server = app.lastServer }
    }

    private func checkStatus() async {
        guard let url = try? parseServerURL(server) else { return }
        needsSetup = (try? await YarvisClient.status(baseURL: url))?.setupRequired ?? false
    }

    private func signIn() async {
        busy = true
        defer { busy = false }
        errorMessage = nil
        do {
            try await app.signIn(serverInput: server, SignInRequest(
                passphrase: passphrase, code: code.trimmingCharacters(in: .whitespaces),
                isBackupCode: useBackupCode, deviceName: deviceName))
            passphrase = ""
            code = ""
        } catch YarvisError.unauthorized {
            errorMessage = "Wrong passphrase or code."
        } catch {
            errorMessage = error.localizedDescription
            await checkStatus()
        }
    }
}
