import SwiftUI
import YarvisClient

struct SettingsView: View {
    @Bindable var model: SettingsModel

    var body: some View {
        Text("Settings").frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Shown instead of the app while the server's vault is locked.
struct VaultUnlockView: View {
    @Bindable var model: SettingsModel

    var body: some View {
        Text("The server's vault is locked.").frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
