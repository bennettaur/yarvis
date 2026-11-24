import SwiftUI
import YarvisClient

/// A message in the code view's place: loading, an error, a file that can't be shown.
struct ReviewCodeNote: View {
    let text: String
    var error = false
    var loading = false

    var body: some View {
        VStack(spacing: 8) {
            if loading { ProgressView().controlSize(.small) }
            Text(text)
                .foregroundStyle(error ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The line a code tab should scroll to. Two things ask: the tab's spec
/// (reopened at a line, with a new nonce each time) and the tab itself (a
/// must-read badge or report note). Whichever asked last wins.
struct ReviewRevealState {
    private(set) var reveal: CodeReveal?
    private var counter = 0

    mutating func follow(line: Int?) {
        counter += 1
        reveal = line.map { CodeReveal(line: $0, key: counter) }
    }

    mutating func jump(_ line: Int) {
        counter += 1
        reveal = CodeReveal(line: line, key: counter)
    }
}

extension ReviewTabSpec {
    /// Changes whenever the spec asks for a line to be shown again.
    var revealRequest: String { "\(revealLine.map(String.init) ?? "-"):\(revealNonce ?? 0)" }
}

/// Status words and colours for a changed file.
func reviewFileStatus(_ status: String) -> (text: String, mark: String, color: Color) {
    switch status {
    case "added": return ("Added", "A", .green)
    case "deleted": return ("Deleted", "D", .red)
    case "renamed": return ("Renamed", "R", .blue)
    default: return ("Modified", "M", .orange)
    }
}

/// "+N −N" in green and red.
struct ReviewLineCounts: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 4) {
            Text("+\(additions)").foregroundStyle(.green)
            Text("−\(deletions)").foregroundStyle(.red)
        }
        .font(.caption.monospaced())
    }
}

/// Reads shared through `ReviewCodeCache`, keyed by the commit they're read at.
@MainActor
enum ReviewCodeReads {
    static func file(_ context: ReviewTabContext, path: String, side: ReviewFileSide) async throws -> ReviewFileContent {
        let pr = context.pr
        let sha = (side == .head ? pr.pr.headSha : pr.pr.mergeBaseSha) ?? ""
        let (client, ws, id) = (context.client, pr.workspaceId, pr.prId)
        return try await ReviewCodeCache.shared.value("file:\(id):\(sha):\(side.rawValue):\(path)") {
            try await client.reviewFile(workspaceId: ws, prId: id, path: path, side: side)
        }
    }

    static func fileKey(_ context: ReviewTabContext, path: String, side: ReviewFileSide) -> String {
        let sha = (side == .head ? context.pr.pr.headSha : context.pr.pr.mergeBaseSha) ?? ""
        return "\(context.pr.prId):\(sha):\(side.rawValue):\(path)"
    }
}

/// Go to definition and find references for one file of a PR, by the
/// sidecar's text search over the checkout. A result opens as the diff
/// when the PR changes the file, the plain file otherwise; a path the PR
/// doesn't have is dropped, since results come from PR code.
@MainActor
func reviewCodeSymbols(_ context: ReviewTabContext, path: String) -> CodeSymbols? {
    let pr = context.pr
    guard pr.pr.headSha != nil else { return nil }
    let client = context.client
    let targets = { () async -> (changed: Set<String>, tree: Set<String>) in
        let changed = Set(pr.changedFiles.value?.files.map(\.path) ?? [])
        if let tree = pr.tree.value?.paths { return (changed, Set(tree)) }
        let tree = (try? await client.reviewTree(workspaceId: pr.workspaceId, prId: pr.prId).paths) ?? []
        return (changed, Set(tree))
    }
    return CodeSymbols(
        search: { kind, word, line in
            do {
                let result = try await client.reviewSymbolSearch(
                    workspaceId: pr.workspaceId, prId: pr.prId, kind: kind, path: path, symbol: word, line: line)
                let (changed, tree) = await targets()
                let matches = result.matches.filter {
                    navigationTab(prId: pr.prId, path: $0.path, line: $0.line, changed: changed, tree: tree) != nil
                }
                if matches.isEmpty {
                    return .message(kind == .definitions ? "No definition found for \(word)."
                                                         : "No references found for \(word).")
                }
                return .matches(matches)
            } catch YarvisError.http(status: 409, _, _) {
                return .message("The checkout isn't ready yet, so code navigation can't search it.")
            } catch {
                return .message("The search failed: \(error.localizedDescription)")
            }
        },
        open: { match in
            let changed = Set(pr.changedFiles.value?.files.map(\.path) ?? [])
            let tree = Set(pr.tree.value?.paths ?? [match.path])
            if let tab = navigationTab(prId: pr.prId, path: match.path, line: match.line, changed: changed, tree: tree) {
                context.openTab(tab)
            }
        })
}
