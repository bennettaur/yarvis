import AppKit
import SwiftUI

/// Covers every screen with the ringing alarm, over other apps and full-screen
/// spaces, the way the Tauri app takes its window full screen.
///
/// The panels show without activating Yarvis. macOS 14 refuses to let an app
/// take focus on its own, and a panel that took keyboard focus while the user
/// types elsewhere would catch keystrokes meant for that app. The takeover's
/// buttons arm only after a moment for the same reason.
@MainActor
final class AlarmTakeoverPanels {
    private var panels: [NSPanel] = []

    var showing: Bool { !panels.isEmpty }

    func show(model: AlarmsModel) {
        guard panels.isEmpty else { return }
        panels = NSScreen.screens.map { screen in
            let panel = TakeoverPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                                      backing: .buffered, defer: false)
            panel.level = .screenSaver
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            panel.hidesOnDeactivate = false
            panel.isReleasedWhenClosed = false
            panel.contentView = NSHostingView(rootView: AlarmTakeoverQueueView(model: model))
            panel.setFrame(screen.frame, display: true)
            panel.orderFrontRegardless()
            return panel
        }
    }

    func hide() {
        for panel in panels { panel.close() }
        panels = []
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
