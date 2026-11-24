import SwiftUI
import YarvisClient

/// Asks before a PR's setup script runs: it isn't sandboxed, so the user
/// sees exactly what would run, and the answer pins that script and commit.
struct ReviewSetupSheet: View {
    let workspace: ReviewWorkspaceModel
    let pr: ReviewPrModel
    @Environment(\.dismiss) private var dismiss
    @State private var info: ReviewSetupInfo?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Run setup for \(pr.ref.displayRepo)#\(pr.ref.number)?").font(.headline)
            Text("Setup is not sandboxed. The script, and any code from this PR it runs (install hooks, build "
                + "scripts, postinstall steps), runs as you, with your files, your credentials and your network. "
                + "Only run it if you trust the author.")
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
            Text("Until you agree, nothing from this PR runs: code navigation uses only the files, and mutation "
                + "testing stays off.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let info { details(info) } else if error == nil { Text("Loading the setup script…").foregroundStyle(.secondary) }
            if let error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Spacer()
                Button("Later") { dismiss() }.disabled(busy).keyboardShortcut(.cancelAction)
                if info?.script != nil {
                    Button("Don't run") { answer(false) }.disabled(busy)
                    // Waits for the detail too, so the fork warning is showing before anything runs.
                    let detailKnown = pr.detail.value != nil
                    Button(busy ? "Starting…" : "Run setup") { answer(true) }
                        .disabled(busy || !setupRunnable(info) || !detailKnown)
                        .help(!setupRunnable(info) ? "The PR's commit isn't known yet"
                            : detailKnown ? "" : "Loading the pull request…")
                }
            }
        }
        .padding(20)
        .frame(width: 560)
        .task {
            pr.loadDetail()
            await load()
        }
    }

    @ViewBuilder
    private func details(_ info: ReviewSetupInfo) -> some View {
        let fromFork = pr.detail.value?.fromFork ?? false
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 2) {
            GridRow {
                Text("Author").foregroundStyle(.secondary)
                Text(info.author ?? "unknown")
            }
            GridRow {
                Text("Branch").foregroundStyle(.secondary)
                HStack {
                    Text(setupBranchLabel(info, fromFork: fromFork)).font(.caption.monospaced()).lineLimit(1)
                    if fromFork { Text("from a fork").foregroundStyle(.orange) }
                }
            }
            GridRow {
                Text("Commit").foregroundStyle(.secondary)
                Text(info.headSha ?? "unknown").font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
            }
        }
        .font(.caption)
        if let script = info.script {
            Text("SETUP SCRIPT, EXACTLY AS IT WILL RUN").font(.caption2).foregroundStyle(.secondary)
            ScrollView {
                Text(script)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(maxHeight: 240)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
        } else {
            Text("This repo has no setup script to run.").foregroundStyle(.secondary)
        }
        if !info.withheldEnv.isEmpty {
            Text("One narrow exception: the script doesn't get \(info.withheldEnv.joined(separator: ", ")). "
                + "Everything else it can reach, it can use.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        ForEach(paragraphs(info.sandboxNotes), id: \.self) { note in
            Text(note).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func load() async {
        info = nil
        do {
            info = try await workspace.client.reviewSetupInfo(workspaceId: workspace.id, prId: pr.prId)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func answer(_ grant: Bool) {
        guard let info else { return }
        busy = true
        error = nil
        Task {
            do {
                _ = try await workspace.client.answerReviewSetup(workspaceId: workspace.id, prId: pr.prId, grant: grant,
                                                                 script: info.script, headSha: info.headSha)
                await workspace.read()
                dismiss()
            } catch YarvisError.http(status: 409, _, _) {
                error = "The setup script or the PR's head changed since this opened. Check what would run now "
                    + "before answering."
                await load()
                busy = false
            } catch {
                self.error = error.localizedDescription
                busy = false
            }
        }
    }
}
