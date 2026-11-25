import AppKit
import SwiftUI
import YarvisClient

/// A small rounded label, such as a status.
struct Chip: View {
    let text: String
    var color: Color = .secondary
    var help: String?

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .foregroundStyle(color)
            .background(color.opacity(0.15), in: RoundedRectangle(cornerRadius: 4))
            .help(help ?? "")
    }
}

func workspaceStatusColor(_ status: String) -> Color {
    switch status {
    case "creating", "archiving", "provisioning": return .orange
    case "active", "ready": return .green
    case "error": return .red
    default: return .secondary
    }
}

struct WorkspaceStatusChip: View {
    let status: String

    var body: some View {
        Chip(text: status, color: workspaceStatusColor(status), help: workspaceStatusHelp(status))
    }
}

struct RepoStatusChip: View {
    let status: String

    var body: some View {
        Chip(text: status, color: workspaceStatusColor(status), help: repoStatusHelp(status))
    }
}

func prGlanceColor(_ glance: PrGlance) -> Color {
    switch glance {
    case .merged: return .purple
    case .closed, .draft: return .secondary
    case .conflicts, .checksFailing: return .red
    case .changesRequested, .checksRunning: return .orange
    case .readyToMerge, .approved: return .green
    case .open: return .cyan
    }
}

struct PrGlanceBadge: View {
    let pr: WorkspaceSummaryPr

    var body: some View {
        let glance = prGlance(pr)
        Text(glance.icon)
            .font(.caption)
            .foregroundStyle(prGlanceColor(glance))
            .help(prGlanceTooltip(pr))
    }
}

func prStateColor(_ state: String?) -> Color {
    switch (state ?? "open").lowercased() {
    case "merged": return .purple
    case "closed": return .secondary
    default: return .green
    }
}

func checksColor(_ rollup: String?) -> Color {
    switch rollup {
    case "success": return .green
    case "failure": return .red
    case "pending": return .orange
    default: return .secondary
    }
}

/// A small copy button that says "Copied" for a moment.
struct CopyButton: View {
    /// Read only when clicked, so a long list's joined paths aren't built on every render.
    let text: () -> String
    var help: String
    @State private var copied = false

    init(text: @autoclosure @escaping () -> String, help: String = "Copy") {
        self.text = text
        self.help = help
    }

    var body: some View {
        Button {
            copyToPasteboard(clipboardSafeText(text()))
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
        .help(help)
    }
}
