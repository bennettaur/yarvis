import SwiftUI
import YarvisClient

/// One file's change since the last review, as a diff of two whole versions:
/// the version reviewed (carried onto today's base) against today's. Two
/// versions of the file read like any other diff, and differ only where the
/// author did something.
struct ReviewSinceFileTab: View {
    let context: ReviewTabContext
    let spec: ReviewTabSpec

    @State private var view: SinceFileView?
    @State private var document: ReviewCodeDocument?
    @State private var loadError: String?
    @State private var attempt = 0
    @State private var wholeFile = false

    private var path: String { spec.path ?? "" }
    private var from: String { spec.from ?? "" }

    var body: some View {
        let pr = context.pr
        Group {
            if pr.pr.headSha == nil {
                ReviewCodeNote(text: "The pull request is still being fetched.")
            } else if let view {
                loaded(view)
            } else if let loadError {
                ReviewCodeNote(text: loadError, error: true) { attempt += 1 }
            } else {
                ReviewCodeNote(text: "Comparing with your review…", loading: true)
            }
        }
        .onAppear {
            pr.loadChangedFiles()
            pr.loadTree()
        }
        .task(id: "\(ReviewCodeReads.loadKey(pr.pr)):\(from):\(context.diffMode.rawValue):\(attempt)") {
            await load()
        }
    }

    @ViewBuilder
    private func loaded(_ data: SinceFileView) -> some View {
        let status = Self.status(data.status)
        let unreadable = data.tooLarge || [data.original, data.modified].contains { $0?.binary == true || $0?.tooLarge == true }
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(path).font(.callout.monospaced()).lineLimit(1).truncationMode(.head).help(path)
                Text("\(status.text) since your review").font(.caption).foregroundStyle(status.color)
                if !unreadable { ReviewLineCounts(additions: data.additions, deletions: data.deletions) }
                Spacer(minLength: 8)
                Toggle("Whole file", isOn: $wholeFile).toggleStyle(.checkbox)
                if data.status != "reverted" {
                    Button("Full PR diff") { context.openTab(.diff(prId: context.pr.prId, path: path)) }
                        .help("The whole change this PR makes to the file")
                }
            }
            .controlSize(.small)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            Divider()
            Text(Self.modeNote(data.mode))
                .font(.caption)
                .foregroundStyle(data.mode == "upstream-included" ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(data.mode == "upstream-included" ? Color.orange.opacity(0.08) : .clear)
            Divider()
            if unreadable {
                ReviewCodeNote(text: "This file is binary or too large to compare here.")
            } else if data.patch.isEmpty {
                ReviewCodeNote(text: "No difference once upstream changes are set aside: the author's change to this file is the same as before.")
            } else if let document {
                ReviewCodeView(document: document, folded: !wholeFile, symbols: reviewCodeSymbols(context, path: path),
                               active: context.isActive)
            } else {
                ReviewCodeNote(text: "Comparing with your review…", loading: true)
            }
        }
    }

    static func status(_ status: String) -> (text: String, color: Color) {
        switch status {
        case "added": return ("Newly changed", .green)
        case "reverted": return ("Reverted", .blue)
        default: return ("Changed again", .orange)
        }
    }

    /// What the left side of the diff is, said once above it.
    static func modeNote(_ mode: String) -> String {
        switch mode {
        case "carried":
            return "Left: the file as you reviewed it, moved onto the current base so upstream changes don't show. Right: the file now."
        case "upstream-included":
            return "Upstream changed the same lines the PR did, so the left side is the file exactly as you reviewed it — some differences come from the base branch, not the author."
        default:
            return "Left: the file as you reviewed it. Right: the file now."
        }
    }

    private func load() async {
        let pr = context.pr
        guard pr.pr.headSha != nil, !from.isEmpty else { return }
        let (client, ws, id, path, from) = (context.client, pr.workspaceId, pr.prId, path, from)
        // The reviewed version depends on the reviewed head and today's merge-base.
        let key = "since:\(id):\(from):\(pr.pr.mergeBaseSha ?? ""):\(pr.pr.headSha ?? ""):\(path)"
        do {
            let data: SinceFileView = try await ReviewCodeCache.shared.value(key) {
                try await client.sinceReviewFile(workspaceId: ws, prId: id, path: path, from: from)
            }
            view = data
            loadError = nil
            let old = data.original?.content ?? ""
            let new = data.modified?.content ?? ""
            let split = context.diffMode == .split
            document = await ReviewCodeCache.shared.document("\(key)|\(split)") {
                .diff(oldKey: "\(key):old", old: old, newKey: "\(key):new", new: new, path: path, split: split)
            }
        } catch {
            loadError = error.localizedDescription
        }
    }
}
