import SwiftUI
import YarvisClient

/// One changed file as a diff: only the changes, with unchanged stretches
/// folded, and the PR's threads, the reviewer's questions and a comment
/// composer inline on either side. A path the PR doesn't change opens as a
/// plain file, so a link into an untouched file still lands somewhere.
struct ReviewDiffTab: View {
    let context: ReviewTabContext
    let spec: ReviewTabSpec

    var body: some View {
        let pr = context.pr
        let path = spec.path ?? ""
        Group {
            if let changed = pr.changedFiles.value {
                if let file = changed.files.first(where: { $0.path == path }) {
                    ReviewChangedFileDiff(context: context, spec: spec, file: file,
                                          order: changedFileOrder(changed.files))
                        .id(path)
                } else {
                    ReviewFileTab(context: context, spec: spec)
                }
            } else if let error = pr.changedFiles.error {
                ReviewCodeNote(text: error, error: true)
            } else if pr.pr.headSha == nil {
                ReviewCodeNote(text: "The pull request is still being fetched.")
            } else {
                ReviewCodeNote(text: "Loading changes…", loading: true)
            }
        }
        .onAppear { pr.loadChangedFiles() }
        .onChange(of: pr.pr.headSha) { pr.loadChangedFiles() }
    }
}

private struct ReviewChangedFileDiff: View {
    let context: ReviewTabContext
    let spec: ReviewTabSpec
    let file: ReviewChangedFile
    let order: [String]

    @State private var wholeFile = false
    @State private var reveal = ReviewRevealState()
    @State private var document: ReviewCodeDocument?
    @State private var head: ReviewFileContent?
    @State private var base: ReviewFileContent?
    @State private var loadError: String?

    private var path: String { file.path }
    private var hasBase: Bool { file.status != "added" }
    private var hasHead: Bool { file.status != "deleted" }
    private var report: VerificationReport? { context.pr.checklist.value?.report }
    private var mustRead: VerificationMustRead? { report?.mustRead?.first { $0.path == path } }

    var body: some View {
        let pr = context.pr
        let notes = fileNotes(report, path: path)
        let annotations = ReviewFileAnnotations(context: context, path: path, headContent: head?.content ?? "",
                                                canComment: true)
        VStack(spacing: 0) {
            toolbar
            Divider()
            if mustRead != nil || !notes.isEmpty {
                ReviewReportNotes(reason: mustRead?.reason, notes: notes) { reveal.jump($0) }
                Divider()
            }
            ReviewAnnotationBar(annotations: annotations, error: pr.viewedError)
            content(annotations, notes: notes)
        }
        .onAppear {
            pr.loadDetail()
            pr.loadInsights()
            pr.loadChecklist()
            pr.loadTree()
            if pr.viewed == nil { pr.loadViewed() }
        }
        .onChange(of: spec.revealRequest, initial: true) { reveal.follow(line: spec.revealLine) }
        .task(id: "\(pr.pr.headSha ?? ""):\(pr.pr.mergeBaseSha ?? ""):\(context.diffMode.rawValue)") { await load() }
    }

    @ViewBuilder
    private var toolbar: some View {
        let pr = context.pr
        let viewed = pr.viewed ?? []
        let isViewed = viewed.contains(path)
        let next = nextUnviewed(order: order, after: path, viewed: viewed)
        let status = reviewFileStatus(file.status)
        HStack(spacing: 10) {
            Group {
                if let old = file.oldPath {
                    Text(old + " → ").foregroundStyle(.secondary) + Text(path)
                } else {
                    Text(path)
                }
            }
            .font(.callout.monospaced())
            .lineLimit(1)
            .truncationMode(.head)
            .help(path)
            Text(status.text).font(.caption).foregroundStyle(status.color)
            if !file.binary { ReviewLineCounts(additions: file.additions, deletions: file.deletions) }
            if let mustRead {
                Button {
                    if let lines = mustRead.lines { reveal.jump(lines.start) }
                } label: {
                    Text("Must read" + (mustRead.lines.map { " · lines \($0.start)–\($0.end)" } ?? ""))
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.orange))
                        .foregroundStyle(.orange)
                }
                .buttonStyle(.plain)
                .disabled(mustRead.lines == nil)
                .help(mustRead.reason)
            }
            Spacer(minLength: 8)
            Toggle("Whole file", isOn: $wholeFile).toggleStyle(.checkbox)
            if hasHead {
                Button("Open file") { context.openTab(.file(prId: pr.prId, path: path)) }
                    .buttonStyle(.link)
            }
            Toggle("Viewed", isOn: Binding(get: { isViewed }, set: { pr.setViewed(path, $0) }))
                .toggleStyle(.checkbox)
                .disabled(pr.viewed == nil)
            if let next {
                Button(isViewed ? "Next unviewed →" : "Viewed, next →") {
                    if !isViewed { pr.setViewed(path, true) }
                    context.openTab(.diff(prId: pr.prId, path: next))
                }
                .help("Mark viewed and open \(next)")
            }
        }
        .controlSize(.small)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private func content(_ annotations: ReviewFileAnnotations, notes: [FileNote]) -> some View {
        if file.binary || base?.binary == true || head?.binary == true {
            ReviewCodeNote(text: "Binary file — no text diff to show.")
        } else if base?.tooLarge == true || head?.tooLarge == true {
            ReviewCodeNote(text: "This file is too large to show here (\(file.additions) additions, \(file.deletions) deletions).")
        } else if let document {
            ReviewCodeView(
                document: document,
                folded: !wholeFile,
                slots: annotations.slots,
                marks: reviewLineMarks(mustRead: mustRead, notes: notes),
                reveal: reveal.reveal,
                annotation: { annotations.view(for: $0) },
                onLineAction: { annotations.perform($0) },
                symbols: reviewCodeSymbols(context, path: path))
        } else if let loadError {
            ReviewCodeNote(text: loadError, error: true)
        } else {
            ReviewCodeNote(text: "Loading file…", loading: true)
        }
    }

    private func load() async {
        guard !file.binary else { return }
        let basePath = file.oldPath ?? path
        do {
            async let baseRead = hasBase ? ReviewCodeReads.file(context, path: basePath, side: .base) : nil
            async let headRead = hasHead ? ReviewCodeReads.file(context, path: path, side: .head) : nil
            let (b, h) = try await (baseRead, headRead)
            base = b
            head = h
            loadError = nil
            guard b?.binary != true, h?.binary != true, b?.tooLarge != true, h?.tooLarge != true else { return }
            let oldKey = ReviewCodeReads.fileKey(context, path: basePath, side: .base)
            let newKey = ReviewCodeReads.fileKey(context, path: path, side: .head)
            let split = context.diffMode == .split
            let (old, new, path) = (b?.content ?? "", h?.content ?? "", path)
            document = await ReviewCodeCache.shared.document("\(oldKey)|\(newKey)|\(split)") {
                .diff(oldKey: oldKey, old: old, newKey: newKey, new: new, path: path, split: split)
            }
        } catch {
            loadError = error.localizedDescription
        }
    }
}

/// The report's must-read range and the lines its notes cite, for the
/// code view to tint, with the notes as the line's hover text.
func reviewLineMarks(mustRead: VerificationMustRead?, notes: [FileNote]) -> [Int: CodeLineMark] {
    var marks: [Int: CodeLineMark] = [:]
    if let lines = mustRead?.lines, lines.start <= lines.end {
        for line in lines.start...min(lines.end, lines.start + 5_000) { marks[line, default: CodeLineMark()].mustRead = true }
    }
    for note in notes {
        let existing = marks[note.line]?.notes
        marks[note.line, default: CodeLineMark()].notes = existing.map { $0 + "\n" + note.hoverText } ?? note.hoverText
    }
    return marks
}

/// Why the verification report wants this file read, and what its checks
/// found in it, each a click from its line. Model-written, so plain text.
private struct ReviewReportNotes: View {
    let reason: String?
    let notes: [FileNote]
    let jump: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let reason { Text(reason) }
            ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Button(":\(note.line)") { jump(note.line) }
                        .buttonStyle(.link)
                        .font(.caption.monospaced())
                    (Text(note.source).foregroundStyle(.secondary)
                        + Text(note.severity.map { " · \($0)" } ?? "").foregroundStyle(.secondary)
                        + Text(" " + note.title))
                        .help(note.detail ?? "")
                }
            }
        }
        .font(.caption)
        .textSelection(.enabled)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.08))
    }
}

/// A whole file at the PR's head, with the same threads, comments and
/// questions as its diff. Comments only go on files the PR changes.
struct ReviewFileTab: View {
    let context: ReviewTabContext
    let spec: ReviewTabSpec

    @State private var reveal = ReviewRevealState()
    @State private var document: ReviewCodeDocument?
    @State private var head: ReviewFileContent?
    @State private var loadError: String?

    private var path: String { spec.path ?? "" }

    var body: some View {
        let pr = context.pr
        let changedFile = pr.changedFiles.value?.files.first { $0.path == path }
        let annotations = ReviewFileAnnotations(context: context, path: path, headContent: head?.content ?? "",
                                                canComment: changedFile.map { $0.status != "deleted" } ?? false)
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(path).font(.callout.monospaced()).lineLimit(1).truncationMode(.head).help(path)
                if changedFile != nil {
                    Button("Changed in this PR — open diff") { context.openTab(.diff(prId: pr.prId, path: path)) }
                        .buttonStyle(.link)
                }
                Spacer()
            }
            .controlSize(.small)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            Divider()
            ReviewAnnotationBar(annotations: annotations)
            if pr.pr.headSha == nil {
                ReviewCodeNote(text: "The pull request is still being fetched.")
            } else if let head, head.binary {
                ReviewCodeNote(text: "Binary file — nothing to show.")
            } else if let head, head.tooLarge {
                ReviewCodeNote(text: "This file is too large to show here (\(Int((Double(head.size) / 1024).rounded())) KB).")
            } else if let document {
                ReviewCodeView(
                    document: document,
                    slots: annotations.slots,
                    reveal: reveal.reveal,
                    annotation: { annotations.view(for: $0) },
                    onLineAction: { annotations.perform($0) },
                    symbols: reviewCodeSymbols(context, path: path))
            } else if let loadError {
                ReviewCodeNote(text: loadError, error: true)
            } else {
                ReviewCodeNote(text: "Loading file…", loading: true)
            }
        }
        .onAppear {
            pr.loadChangedFiles()
            pr.loadDetail()
            pr.loadInsights()
            pr.loadTree()
        }
        .onChange(of: spec.revealRequest, initial: true) { reveal.follow(line: spec.revealLine) }
        .task(id: "\(pr.pr.headSha ?? ""):\(path)") { await load() }
    }

    private func load() async {
        guard context.pr.pr.headSha != nil else { return }
        do {
            let file = try await ReviewCodeReads.file(context, path: path, side: .head)
            head = file
            loadError = nil
            guard !file.binary, !file.tooLarge else { return }
            let key = ReviewCodeReads.fileKey(context, path: path, side: .head)
            let (content, path) = (file.content, path)
            document = await ReviewCodeCache.shared.document("file:\(key)") {
                .file(key: key, content: content, path: path)
            }
        } catch {
            loadError = error.localizedDescription
        }
    }
}
