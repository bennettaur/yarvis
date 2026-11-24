import SwiftUI
import YarvisClient

// Small views and helpers the agent tabs share: chips, path links, notices,
// timing. Everything they show from a report is model-written, so it is
// plain `Text`, never Markdown.

extension ReportTone {
    var color: Color {
        switch self {
        case .good: return .green
        case .warn: return .orange
        case .bad: return .red
        case .muted: return .secondary
        }
    }
}

extension Chip {
    init(_ chip: ReportChip, help: String? = nil) {
        self.init(text: chip.text, color: chip.tone.color, help: help)
    }
}

/// `path` or `path:line` as a link when the PR has the file, plain text otherwise.
struct ReviewPathLink: View {
    let path: String
    var line: Int?
    /// A label for the line part, such as `:12–20`; defaults to `:line`.
    var suffix: String?
    let canOpen: Bool
    let open: () -> Void

    var body: some View {
        let text = path + (suffix ?? line.map { ":\($0)" } ?? "")
        Group {
            if canOpen {
                Button(text, action: open).buttonStyle(.link).help(text)
            } else {
                Text(text).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
        .font(.caption.monospaced())
        .lineLimit(1)
        .truncationMode(.middle)
    }
}

/// What a tab may link to and how: a diff when the PR changes the path, the
/// file when it's only in the tree.
@MainActor
struct ReviewLinks {
    let context: ReviewTabContext

    var changed: Set<String> { Set(context.pr.changedFiles.value?.files.map(\.path) ?? []) }
    var tree: Set<String> { Set(context.pr.tree.value?.paths ?? []) }

    func isChanged(_ path: String) -> Bool { changed.contains(path) }

    /// Opens the diff at `line`, or the file when the PR doesn't change it.
    func open(_ path: String, line: Int? = nil) {
        let prId = context.pr.prId
        context.openTab(isChanged(path)
            ? .diff(prId: prId, path: path, revealLine: line)
            : .file(prId: prId, path: path, revealLine: line))
    }
}

/// "N binary files have no diff to read: a, b, c and 2 more".
struct FileNoticesView: View {
    let notices: [FileNotice]

    var body: some View {
        if !notices.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(notices, id: \.text) { notice in
                    FileNoticeRow(notice: notice)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}

private struct FileNoticeRow: View {
    let notice: FileNotice
    @State private var expanded = false

    /// Paths named before the rest fold away.
    private let shown = 3

    var body: some View {
        let rest = notice.paths.count - shown
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Text("\(notice.text): ") + Text(notice.paths.prefix(shown).joined(separator: ", ")).font(.caption.monospaced())
                if rest > 0 && !expanded {
                    Button("and \(rest) more") { expanded = true }.buttonStyle(.link)
                }
            }
            if expanded {
                Text(notice.paths.dropFirst(shown).joined(separator: ", ")).font(.caption.monospaced())
                    .textSelection(.enabled)
            }
        }
    }
}

/// A red line for an action's failure.
struct ReviewErrorText: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text).font(.caption).foregroundStyle(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
    }
}

/// A spinner with what it waits for.
struct ReviewWaiting: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.small)
            Text(text).font(.callout).foregroundStyle(.secondary)
        }
    }
}

/// A collapsible group with a caption-sized label.
struct ReviewFold<Content: View>: View {
    let title: String
    var initiallyOpen = false
    @ViewBuilder let content: () -> Content
    @State private var open: Bool?

    var body: some View {
        DisclosureGroup(isExpanded: Binding(get: { open ?? initiallyOpen }, set: { open = $0 })) {
            VStack(alignment: .leading, spacing: 6) { content() }.padding(.top, 4)
        } label: {
            Text(title).font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// "3 hours ago" for an ISO date, or the raw string when it doesn't parse.
func longAgo(_ iso: String, now: Date = Date()) -> String {
    guard let date = parseISODate(iso) else { return iso }
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .full
    return f.localizedString(for: date, relativeTo: now)
}

extension View {
    /// Runs `tick` every `seconds` while `active` holds, the tab is the one
    /// showing in its group and the page is on screen. Restarts whenever
    /// either changes.
    func reviewPoll(_ context: ReviewTabContext, every seconds: Double = 3, while active: Bool,
                    _ tick: @escaping @MainActor () -> Void) -> some View {
        let polling = active && context.isActive
        return task(id: polling) {
            guard polling else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(seconds))
                if Task.isCancelled { return }
                if context.workspace.page.pageVisible { tick() }
            }
        }
    }
}

/// The section heading the agent tabs use.
struct ReviewSectionTitle: View {
    let text: String
    var count: Int?

    init(_ text: String, count: Int? = nil) {
        self.text = text
        self.count = count
    }

    var body: some View {
        HStack(spacing: 4) {
            Text(text.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if let count { Text("\(count)").font(.caption).foregroundStyle(.tertiary) }
        }
    }
}
