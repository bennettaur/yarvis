import AppKit
import SwiftUI
import YarvisClient

/// One file's diff. Clicking a new-file line number starts a comment there;
/// shift-clicking another stretches it to a range.
struct WorkspaceDiffView: View {
    @Bindable var model: WorkspaceDiffModel
    let detail: WorkspaceDetailModel

    var body: some View {
        let comments = model.comments
        let byEndLine = Dictionary(grouping: comments, by: \.endLine)
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(model.path).font(.callout.monospaced()).lineLimit(1).truncationMode(.head)
                if !comments.isEmpty {
                    Text("\(comments.count) comment\(comments.count == 1 ? "" : "s")")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Refresh", action: model.refresh).controlSize(.small)
            }
            .padding(8)
            Divider()
            if let error = model.error {
                Text(error).foregroundStyle(.red).padding()
                Spacer()
            } else if !model.loaded {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.lines.isEmpty {
                Text("No textual diff (binary or unchanged).")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(model.lines) { line in
                            DiffRow(line: line, selected: line.newLine.map { model.selection?.contains($0) ?? false } ?? false,
                                    commentable: model.commentable) {
                                guard let n = line.newLine else { return }
                                model.select(line: n, extend: NSEvent.modifierFlags.contains(.shift))
                            }
                            if let n = line.newLine {
                                if model.selection?.upperBound == n { CommentComposer(model: model) }
                                ForEach(byEndLine[n] ?? []) { comment in
                                    ReviewCommentCard(model: detail, comment: comment, showsLocation: false)
                                        .padding(.leading, 90)
                                        .padding(.vertical, 2)
                                        .frame(maxWidth: 700, alignment: .leading)
                                }
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }
}

private struct DiffRow: View {
    let line: DiffLine
    let selected: Bool
    let commentable: Bool
    let onGutterClick: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Text(line.oldLine.map(String.init) ?? "")
                .frame(width: 40, alignment: .trailing)
                .foregroundStyle(.secondary)
            Text(line.newLine.map(String.init) ?? "")
                .frame(width: 40, alignment: .trailing)
                .foregroundStyle(line.newLine == nil ? .secondary : .primary)
                .contentShape(Rectangle())
                .onTapGesture(perform: onGutterClick)
                .help(line.newLine == nil || !commentable ? "" : "Click to comment on this line; shift-click to pick a range")
            Text(marker)
                .frame(width: 16)
                .foregroundStyle(color)
            Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(line.kind == .hunk || line.kind == .meta ? .secondary : .primary)
                .fixedSize()
            Spacer(minLength: 0)
        }
        .font(.system(.caption, design: .monospaced))
        .padding(.vertical, 0.5)
        .background(selected ? Color.accentColor.opacity(0.25) : background)
    }

    private var marker: String {
        switch line.kind {
        case .added: return "+"
        case .removed: return "-"
        default: return ""
        }
    }

    private var color: Color {
        switch line.kind {
        case .added: return .green
        case .removed: return .red
        default: return .secondary
        }
    }

    private var background: Color {
        switch line.kind {
        case .added: return .green.opacity(0.12)
        case .removed: return .red.opacity(0.12)
        case .hunk: return .secondary.opacity(0.1)
        default: return .clear
        }
    }
}

private struct CommentComposer: View {
    @Bindable var model: WorkspaceDiffModel

    var body: some View {
        if let range = model.selection {
            VStack(alignment: .leading, spacing: 6) {
                Text(range.count == 1 ? "Line \(range.lowerBound)" : "Lines \(range.lowerBound)–\(range.upperBound)")
                    .font(.caption.weight(.medium))
                TextEditor(text: $model.draft)
                    .font(.callout)
                    .frame(height: 70)
                    .overlay(alignment: .topLeading) {
                        if model.draft.isEmpty {
                            Text("Note for yourself (or for Claude)…")
                                .foregroundStyle(.tertiary).padding(5).allowsHitTesting(false)
                        }
                    }
                    .border(.quaternary)
                HStack {
                    Button("Save comment", action: model.saveComment)
                        .disabled(model.saving || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Cancel", action: model.cancelComment)
                    if let error = model.composeError {
                        Text(error).font(.caption).foregroundStyle(.red)
                    }
                }
                .controlSize(.small)
            }
            .padding(8)
            .frame(maxWidth: 600, alignment: .leading)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
            .padding(.leading, 90)
            .padding(.vertical, 4)
        }
    }
}

/// A plain-text editor for one worktree file, which refuses to overwrite a
/// change made on disk since it was opened unless asked to.
struct WorkspaceEditorView: View {
    @Bindable var model: WorkspaceEditorModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(model.path).font(.callout.monospaced()).lineLimit(1).truncationMode(.head)
                if model.dirty { Text("●").foregroundStyle(.orange) }
                Spacer()
                if let error = model.error { Text(error).font(.caption).foregroundStyle(.red).lineLimit(2) }
                Button(model.dirty ? "Revert" : "Reload", action: model.revert).controlSize(.small)
                Button("Save", action: model.save)
                    .controlSize(.small)
                    .keyboardShortcut("s", modifiers: .command)
                    .disabled(!model.dirty || model.saving)
            }
            .padding(8)
            if model.conflict {
                HStack {
                    Text("This file changed on disk after you opened it — most likely the agent working in this worktree. Your edits are still here.")
                        .font(.caption)
                    Spacer()
                    Button("Discard mine, reload from disk", action: model.revert).controlSize(.small)
                    Button("Overwrite with mine", action: model.overwrite).controlSize(.small)
                }
                .padding(8)
                .background(.orange.opacity(0.2))
            }
            Divider()
            if let message = model.unreadableMessage {
                Text("\(message) (\(model.size) bytes)")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !model.loaded {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                TextEditor(text: $model.text)
                    .font(.system(.callout, design: .monospaced))
                    .autocorrectionDisabled()
            }
        }
    }
}
