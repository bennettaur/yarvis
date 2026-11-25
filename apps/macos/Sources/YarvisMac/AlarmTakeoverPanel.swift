import AppKit
import SwiftUI

/// Covers every screen with the ringing alarm, over other apps and full-screen
/// spaces, the way the Tauri app takes its window full screen.
///
/// The panels show without activating Yarvis: macOS 14 refuses to let an app
/// take focus on its own. The main screen's panel takes keyboard focus anyway,
/// which a non-activating panel may do, so typing meant for the app it covers
/// doesn't land in a window the user can no longer see. The takeover's buttons
/// arm only after a moment, and none answers Return, so those keystrokes do
/// nothing.
@MainActor
final class AlarmTakeoverPanels {
    private var panels: [NSPanel] = []
    private weak var model: AlarmsModel?
    private var screensObserver: NSObjectProtocol?

    func show(model: AlarmsModel) {
        guard panels.isEmpty || self.model !== model else { return }
        hide()
        self.model = model
        panels = NSScreen.screens.map { screen in
            let panel = TakeoverPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                                      backing: .buffered, defer: false)
            panel.level = .screenSaver
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            panel.hidesOnDeactivate = false
            panel.isReleasedWhenClosed = false
            panel.contentView = NSHostingView(rootView: AlarmTakeoverQueueView(model: model))
            panel.orderFrontRegardless()
            return panel
        }
        panels.first?.makeKey()
        // A display plugged in or removed mid-alarm gets its own panel, or loses one.
        screensObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let model = self.model else { return }
                self.hide()
                self.show(model: model)
            }
        }
    }

    func hide() {
        if let screensObserver { NotificationCenter.default.removeObserver(screensObserver) }
        screensObserver = nil
        for panel in panels { panel.close() }
        panels = []
        model = nil
    }
}

/// Borderless windows can't become key by default, which would leave the
/// takeover's buttons needing a second click.
private final class TakeoverPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// The front of the takeover queue. Reads the queue itself, so answering one
/// alarm hands the panel to the next without rebuilding it.
private struct AlarmTakeoverQueueView: View {
    let model: AlarmsModel

    var body: some View {
        if let alarm = model.takeoverQueue.first {
            AlarmTakeoverView(model: model, alarm: alarm, remaining: model.takeoverQueue.count - 1)
        }
    }
}
