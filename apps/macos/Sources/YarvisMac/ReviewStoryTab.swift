import SwiftUI
import YarvisClient

/// A file's patch as Story shows it, parsed and coloured once when it arrives.
enum ReviewStoryDiff {
    case loading
    case failed(String)
    case tooLarge
    /// Rows of the whole patch; `spans` colour each row's text, when the language is known.
    case rows([DiffLine], spans: [[SyntaxSpan]]?)
}

/// One PR's story: the chapter chosen and the patches read for it.
@MainActor @Observable
final class ReviewStoryModel: ReviewTabModel {
    private let client: YarvisClient
    let workspaceId: String
    let prId: String

    /// Nil until the reader picks one; the first unread chapter shows until then.
    var chosen: String?
    private(set) var diffs: [String: ReviewStoryDiff] = [:]
    private var diffHead: String?
    private(set) var starting = false
    var startError: String?
    private var tasks: [String: Task<Void, Never>] = [:]

    init(client: YarvisClient, workspaceId: String, prId: String) {
        self.client = client
        self.workspaceId = workspaceId
        self.prId = prId
    }

    /// Reads a file's patch once per head.
    func loadDiff(_ path: String, head: String?) {
        if diffHead != head {
            diffHead = head
            diffs = [:]
        }
        guard diffs[path] == nil, head != nil else { return }
        diffs[path] = .loading
        tasks["diff:\(path)"] = Task {
            do {
                let diff = try await client.reviewFileDiff(workspaceId: workspaceId, prId: prId, path: path)
                guard diffHead == head else { return }
                diffs[path] = diff.tooLarge ? .tooLarge : Self.parse(diff.patch, path: path)
            } catch {
                guard diffHead == head, !Task.isCancelled else { return }
                diffs[path] = .failed(error.localizedDescription)
            }
        }
    }

    /// Each row's text is coloured as part of one document, so a string or
    /// comment that spans rows is still recognised.
    private static func parse(_ patch: String, path: String) -> ReviewStoryDiff {
        let rows = parseUnifiedDiff(patch)
        let spans = languageForPath(path).flatMap { language in
            highlightLines(rows.map { $0.kind == .hunk || $0.kind == .meta ? "" : $0.text }.joined(separator: "\n"),
                           language: language)
        }
        return .rows(rows, spans: spans)
    }

    func writeChangeMap(_ pr: ReviewPrModel) {
        starting = true
        startError = nil
        tasks["changeMap"] = Task {
            do {
                let started = try await client.startVerification(workspaceId: workspaceId, prId: prId,
                                                                 sections: ["changeMap"])
                startError = started.failed.first?.error
            } catch {
                startError = error.localizedDescription
            }
            // Re-read either way: a refused start can still mean a run is going.
            pr.loadChecklist(force: true)
            starting = false
        }
    }

    func stop() {
        for task in tasks.values { task.cancel() }
        tasks = [:]
        diffs = diffs.filter { if case .rows = $0.value { return true } else { return false } }
        starting = false
    }
}

/// The PR read theme by theme from the change map, the work that matters first.
struct ReviewStoryTab: View {
    let context: ReviewTabContext

    private var pr: ReviewPrModel { context.pr }

    private var model: ReviewStoryModel {
        context.workspace.tabModels.get(pr.prId) {
            ReviewStoryModel(client: context.client, workspaceId: pr.workspaceId, prId: pr.prId)
        }
    }

    var body: some View {
        let model = model
        let checklist = pr.checklist.value
        let mapItem = checklist?.items.first { $0.section == "changeMap" }
        let running = mapItem?.latest?.status == "running"
        Group {
            if checklist == nil {
                VStack {
                    if let error = pr.checklist.error { ReviewErrorText(error) } else { ReviewWaiting("Loading the change map…") }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let map = checklist?.report?.changeMap, !storyChapters(map).isEmpty {
                story(model, map: map, item: mapItem, running: running)
            } else {
                noMap(model, running: running)
            }
        }
        .onAppear {
            pr.loadChecklist()
            pr.loadViewed()
            pr.loadChangedFiles()
        }
        .reviewPoll(context, while: running) { pr.loadChecklist(force: true) }
    }

    private func noMap(_ model: ReviewStoryModel, running: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Story mode reads the PR theme by theme, the work that matters first: each chapter says what changed and why, above the hunks it covers. The chapters come from the change map, which an agent writes.")
                .foregroundStyle(.secondary)
            if running {
                ReviewWaiting("Writing the change map…")
            } else {
                Button(model.starting ? "Starting…" : "Write the change map") { model.writeChangeMap(pr) }
                    .disabled(model.starting || !pr.pr.checkoutReady)
                    .help(pr.pr.checkoutReady ? "" : "Waiting for the checkout")
            }
            if let error = model.startError { ReviewErrorText(error) }
        }
        .padding(16)
        .frame(maxWidth: 640, maxHeight: .infinity, alignment: .topLeading)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func chapterLabel(_ chapter: StoryChapter, read: Bool) -> Text {
        let outlier = Text(chapter.cohesion == "outlier" ? " · outlier" : "").foregroundColor(.orange)
        let tick = Text(read ? " ✓" : "").foregroundColor(.green)
        return Text(chapter.title) + outlier + tick
    }

    private func story(_ model: ReviewStoryModel, map: VerificationChangeMap, item: ChecklistItem?,
                       running: Bool) -> some View {
        let chapters = storyChapters(map)
        let viewed = pr.viewed ?? []
        let readCount = chapters.filter { chapterRead($0, viewed: viewed) }.count
        let current = chapters.firstIndex { $0.id == model.chosen }
            ?? chapters.firstIndex { !chapterRead($0, viewed: viewed) } ?? 0
        var status = "\(readCount) of \(chapters.count) chapters read"
        if let result = item?.result, !result.current { status += " · written for an older commit (\(reportSha(result.headSha)))" }
        if running { status += " · rewriting" }
        return HSplitView {
            List {
                Text(map.intent).font(.callout).textSelection(.enabled)
                Text(status).font(.caption).foregroundStyle(.secondary)
                ForEach(Array(chapters.enumerated()), id: \.element.id) { i, chapter in
                    let read = chapterRead(chapter, viewed: viewed)
                    Button {
                        model.chosen = chapter.id
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("\(i + 1).").monospacedDigit().foregroundStyle(.secondary)
                            chapterLabel(chapter, read: read)
                        }
                        .opacity(read ? 0.6 : 1)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(i == current ? Color.accentColor.opacity(0.15) : Color.clear)
                }
            }
            .frame(minWidth: 180, idealWidth: 240, maxWidth: 320)
            ScrollView {
                ReviewStoryChapter(context: context, model: model, chapters: chapters, index: current)
                    .id(chapters[current].id)
                    .padding(16)
                    .frame(maxWidth: 900, alignment: .leading)
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

/// One chapter: what the theme is, then each file's part of the patch.
private struct ReviewStoryChapter: View {
    let context: ReviewTabContext
    let model: ReviewStoryModel
    let chapters: [StoryChapter]
    let index: Int
    @State private var showAll = false

    var body: some View {
        let chapter = chapters[index]
        let files = showAll ? chapter.files : Array(chapter.files.prefix(storyFilesShown))
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Text("Chapter \(index + 1) of \(chapters.count)").font(.caption).foregroundStyle(.secondary)
                if let cohesion = chapter.cohesion {
                    Chip(text: cohesion.capitalized, color: cohesion == "outlier" ? .orange : cohesion == "core" ? .blue : .secondary)
                }
                if let risk = chapter.risk {
                    Chip(text: "\(risk) risk", color: risk == "high" ? .red : risk == "medium" ? .orange : .green)
                }
            }
            Text(chapter.title).font(.title3.weight(.semibold)).textSelection(.enabled)
            if !chapter.description.isEmpty { Text(chapter.description).textSelection(.enabled) }
            if !chapter.question.isEmpty {
                Text("Ask the author: \(chapter.question)").foregroundStyle(.orange).textSelection(.enabled)
            }
            ForEach(files, id: \.path) { file in
                ReviewStoryFile(context: context, model: model, file: file)
            }
            if !showAll && chapter.files.count > storyFilesShown {
                Button("Show \(chapter.files.count - storyFilesShown) more files") { showAll = true }
            }
            HStack {
                Button("Back") { model.chosen = chapters[index - 1].id }.disabled(index == 0)
                Spacer()
                Button(index == chapters.count - 1 ? "Mark read" : "Mark read and continue") {
                    context.pr.setViewed(chapter.files.map(\.path), true)
                    if index + 1 < chapters.count { model.chosen = chapters[index + 1].id }
                }
                .disabled(context.pr.viewed == nil)
            }
            .padding(.top, 8)
        }
    }
}

/// A file's part in a chapter: the hunks that touch the theme's lines, with
/// the report's notes on them.
private struct ReviewStoryFile: View {
    let context: ReviewTabContext
    let model: ReviewStoryModel
    let file: ChangeTheme.File

    var body: some View {
        let links = ReviewLinks(context: context)
        let range = file.lines.map { $0.start == $0.end ? ":\($0.start)" : ":\($0.start)-\($0.end)" } ?? ""
        VStack(alignment: .leading, spacing: 6) {
            ReviewPathLink(path: file.path, suffix: range, canOpen: links.isChanged(file.path)) {
                links.open(file.path, line: file.lines?.start)
            }
            .font(.callout.monospaced())
            patch
        }
        .task(id: "\(file.path):\(context.pr.pr.headSha ?? "")") {
            if context.pr.pr.checkoutReady { model.loadDiff(file.path, head: context.pr.pr.headSha) }
        }
    }

    @ViewBuilder private var patch: some View {
        if !context.pr.pr.checkoutReady {
            note("The diff shows once the checkout is ready.")
        } else {
            switch model.diffs[file.path] {
            case nil, .loading?:
                ReviewWaiting("Reading the diff…")
            case .failed(let error)?:
                ReviewErrorText(error)
            case .tooLarge?:
                note("Too large to show here; click the path above.")
            case .rows(let all, let spans)?:
                rows(rowsInRange(all, lines: file.lines), spans: spans)
            }
        }
    }

    @ViewBuilder private func rows(_ rows: [DiffLine], spans: [[SyntaxSpan]]?) -> some View {
        if rows.filter({ $0.kind != .hunk }).isEmpty {
            note("No text changes to show here; click the path above.")
        } else {
            let notes = fileNotes(context.pr.checklist.value?.report, path: file.path).filter { n in
                file.lines.map { n.line >= $0.start && n.line <= $0.end } ?? true
            }
            let shown = Array(rows.prefix(storyMaxRows))
            let headLines = Set(shown.compactMap(\.newLine))
            VStack(alignment: .leading, spacing: 0) {
                ForEach(shown) { row in
                    ReviewStoryRow(row: row, spans: spans.flatMap { $0.indices.contains(row.id) ? $0[row.id] : nil } ?? [])
                    if let line = row.newLine {
                        ForEach(Array(notes.filter { $0.line == line }.enumerated()), id: \.offset) { ReviewStoryNote(note: $1) }
                    }
                }
            }
            .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 4))
            if rows.count > storyMaxRows {
                note("\(rows.count - storyMaxRows) more lines; click the path above for the rest.")
            }
            let elsewhere = notes.filter { !headLines.contains($0.line) }
            if !elsewhere.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(elsewhere.enumerated()), id: \.offset) { _, n in
                        (Text("\(n.source) (line \(n.line)): ").foregroundColor(.orange) + Text(n.title)
                            + Text(n.detail.map { " — \($0)" } ?? "").foregroundColor(.secondary))
                            .font(.caption)
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.secondary)
    }
}

private struct ReviewStoryRow: View {
    let row: DiffLine
    let spans: [SyntaxSpan]

    var body: some View {
        HStack(spacing: 0) {
            Text(row.oldLine.map(String.init) ?? "").frame(width: 40, alignment: .trailing)
            Text(row.newLine.map(String.init) ?? "").frame(width: 40, alignment: .trailing)
            Text(marker).frame(width: 16)
            Text(styled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .padding(.vertical, 1)
        .background(background)
        .textSelection(.enabled)
    }

    private var marker: String {
        switch row.kind {
        case .added: return "+"
        case .removed: return "-"
        default: return ""
        }
    }

    /// The row's text in the code view's syntax colours.
    private var styled: AttributedString {
        let text = row.text.isEmpty ? " " : row.text
        guard row.kind != .hunk, row.kind != .meta, !spans.isEmpty else {
            var plain = AttributedString(text)
            plain.foregroundColor = row.kind == .hunk ? .secondary : .primary
            return plain
        }
        let ns = NSMutableAttributedString(string: text, attributes: [.foregroundColor: NSColor.textColor])
        for span in spans where span.start + span.length <= ns.length {
            ns.addAttribute(.foregroundColor, value: CodeRowView.color(span.kind),
                            range: NSRange(location: span.start, length: span.length))
        }
        return (try? AttributedString(ns, including: \.appKit)) ?? AttributedString(text)
    }

    private var background: Color {
        switch row.kind {
        case .added: return .green.opacity(0.15)
        case .removed: return .red.opacity(0.15)
        case .hunk: return .blue.opacity(0.08)
        default: return .clear
        }
    }
}

/// A report note under its line. Model-written, so plain text.
private struct ReviewStoryNote: View {
    let note: FileNote

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(note.source).font(.caption.weight(.medium)).foregroundStyle(note.severity == "high" ? .red : .orange)
            Text(note.title).font(.caption)
            if let detail = note.detail, !detail.isEmpty {
                Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.08))
        .help(note.hoverText)
    }
}
