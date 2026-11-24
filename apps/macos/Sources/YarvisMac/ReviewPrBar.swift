import SwiftUI
import YarvisClient

/// The front PR's bar: status, the agent tabs, review and merge actions,
/// and the conflict and new-commits banners.
struct ReviewPrBarView: View {
    let workspace: ReviewWorkspaceModel
    let pr: ReviewPrModel
    @Bindable var bar: ReviewPrBarModel
    @State private var removing = false

    private var status: PrUiStatus {
        derivePrUiStatus(pr.detail.value, fallbackState: "open", fallbackDraft: false)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(reviewPrColor(pr.pr.colorIndex)).frame(width: 8, height: 8)
                Text(prLabel(pr.ref)).font(.caption.monospaced())
                Text(pr.pr.title).font(.callout.weight(.medium)).lineLimit(1)
                Chip(text: status.label, color: Self.color(status))
                Spacer()
                tabButton("Guided review", .guide)
                tabButton("Story", .story)
                tabButton("Ask Claude", .claude)
                moreMenu
            }
            ReviewPrActionsRow(pr: pr, bar: bar, status: status)
            if let message = bar.markMessage { note(message) }
            if let error = bar.actionError { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            ReviewConflictBanner(workspace: workspace, pr: pr, bar: bar)
            ReviewNewCommitsBanner(workspace: workspace, pr: pr, bar: bar)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .overlay(alignment: .leading) { Rectangle().fill(reviewPrColor(pr.pr.colorIndex)).frame(width: 3) }
        .onAppear {
            pr.loadDetail()
            pr.loadStatus()
            bar.lookUpWorkspace()
        }
        .onChange(of: pr.detail.value) { _, _ in bar.detailChanged() }
        // A push shows as the provider's head moving past the checkout's.
        .task(id: pr.prId) {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(120))
                if workspace.page.pageVisible { pr.loadStatus(force: true) }
            }
        }
        .sheet(isPresented: $removing) {
            ReviewConfirmSheet(
                title: "Remove \(prLabel(pr.ref)) from the workspace?",
                message: "Closes its tabs and deletes its checkout. Comments and reviews on the provider are "
                    + "untouched, and you can add the PR again later.",
                action: "Remove", busyLabel: "Removing…"
            ) {
                try await workspace.client.removeReviewPr(workspaceId: workspace.id, prId: pr.prId)
                await workspace.read()
            }
        }
    }

    private func tabButton(_ title: String, _ kind: ReviewTabSpec.Kind) -> some View {
        Button(title) { workspace.openTab(ReviewTabSpec(kind: kind, prId: pr.prId)) }.controlSize(.small)
    }

    private var moreMenu: some View {
        Menu {
            Button("Update checkout") { bar.refreshCheckout() }
                .disabled(bar.refreshing || pr.pr.status != "ready")
            Button("Mark reviewed here") { bar.markReviewedHere() }
                .disabled(pr.pr.headSha == nil)
            Button("Mutation testing") { workspace.openTab(ReviewTabSpec(kind: .mutation, prId: pr.prId)) }
            Divider()
            Button("Remove from workspace…", role: .destructive) { removing = true }
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuIndicator(.hidden)
        .fixedSize()
        .controlSize(.small)
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.secondary)
    }

    static func color(_ status: PrUiStatus) -> Color {
        switch status {
        case .draft, .closed: return .secondary
        case .ciFailing: return .red
        case .awaitingReview: return .orange
        case .readyToMerge: return .green
        case .merged: return .purple
        }
    }
}

private struct ReviewPrActionsRow: View {
    let pr: ReviewPrModel
    @Bindable var bar: ReviewPrBarModel
    let status: PrUiStatus

    var body: some View {
        let detail = pr.detail.value
        let controls = mergeControlsFor(detail, status: status)
        let blocked = bar.busy ? "Another action on this PR is still in progress" : ""
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                workspaceButton(detail)
                switch status {
                case .draft:
                    Button("Ready for review") { bar.markReady() }.disabled(bar.busy).help(blocked)
                case .merged, .closed:
                    EmptyView()
                default:
                    if bar.approved {
                        Text("✓ Approved").font(.caption).foregroundStyle(.green)
                    } else {
                        Button("Approve") { bar.prompt = bar.prompt == .approve ? nil : .approve }
                            .disabled(bar.busy).help(blocked)
                    }
                    Button("Request changes") { bar.prompt = bar.prompt == .requestChanges ? nil : .requestChanges }
                        .disabled(bar.busy).help(blocked)
                }
                if detail?.autoMergeEnabled == true {
                    Chip(text: "Auto-merge on", color: .green)
                }
                if controls.merge { mergeMenu("Merge", bar.merge) }
                if controls.enableAuto { mergeMenu("Enable auto-merge", bar.enableAutoMerge) }
                if controls.disableAuto {
                    Button("Cancel auto-merge") { bar.disableAutoMerge() }.disabled(bar.busy).help(blocked)
                }
                Spacer()
                Button { pr.refreshProvider() } label: { Text("↻") }
                    .help("Read the pull request again")
                if let url = pr.ref.webURL {
                    Button { openWebLink(url) } label: { Text("↗") }
                        .help("Open on \(pr.ref.providerName)")
                    CopyButton(text: url.absoluteString, help: "Copy the PR's link")
                }
            }
            .controlSize(.small)
            if let prompt = bar.prompt { promptRow(prompt) }
            if let error = bar.workspaceError { Text(error).font(.caption).foregroundStyle(.red) }
        }
    }

    @ViewBuilder
    private func workspaceButton(_ detail: PrDetail?) -> some View {
        if bar.workspaceLookedUp {
            if let linked = bar.linkedWorkspace {
                Button("⤴ \(linked.name)") { bar.openOrStartWorkspace() }
                    .help("Jump to the “\(linked.name)” workspace")
            } else {
                let fork = detail?.fromFork == true
                Button(bar.startingWorkspace ? "Starting…" : "⎇ Start workspace") { bar.openOrStartWorkspace() }
                    .disabled(fork || bar.startingWorkspace)
                    .help(fork ? "This pull request comes from a fork, so its branch is not in the repository"
                        : "Create a workspace on this pull request's branch and open an agent session there")
            }
        }
    }

    private func mergeMenu(_ title: String, _ pick: @escaping (MergeMethod) -> Void) -> some View {
        Menu(title) {
            ForEach(pr.detail.value?.mergeMethods ?? [], id: \.self) { method in
                Button(method.menuLabel) { pick(method) }
            }
        }
        .fixedSize()
        .disabled(bar.busy)
    }

    private func promptRow(_ prompt: ReviewPrBarModel.Prompt) -> some View {
        let required = prompt == .requestChanges
        return HStack(alignment: .top) {
            TextField(required ? "What needs to change?" : "Optional comment for the approval…",
                      text: $bar.promptBody, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...6)
            Button(required ? "Submit" : "Approve") { bar.submitPrompt() }
                .disabled(bar.busy || (required && bar.promptBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            Button("Cancel") {
                bar.prompt = nil
                bar.promptBody = ""
            }
        }
        .controlSize(.small)
    }
}

private struct ReviewConflictBanner: View {
    let workspace: ReviewWorkspaceModel
    let pr: ReviewPrModel
    @Bindable var bar: ReviewPrBarModel

    var body: some View {
        let state = prConflictState(pr.detail.value)
        VStack(spacing: 0) {
            if state == .conflicts, let detail = pr.detail.value { banner(detail) }
        }
        // Mergeability is still being worked out: look once more shortly.
        .task(id: state == .computing) {
            guard state == .computing, !bar.recheckedMergeability else { return }
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            bar.recheckedMergeability = true
            pr.loadDetail(force: true)
        }
    }

    private func banner(_ detail: PrDetail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Conflicts with \(detail.baseRef.isEmpty ? "the base branch" : detail.baseRef)")
                .font(.callout.weight(.medium))
            if detail.fromFork {
                Text("This pull request comes from a fork, so its branch can't be checked out in a workspace; "
                    + "resolve them on \(detail.headRef.isEmpty ? "the fork" : detail.headRef) itself.")
                    .font(.caption)
            }
            HStack {
                switch bar.conflictStep {
                case .idle:
                    Button("Resolve conflicts") { bar.resolveConflicts(confirm: false) }
                        .disabled(detail.fromFork)
                        .help("Have a coding agent merge the base branch into this PR, resolve the conflicts and push")
                case .pending:
                    Text("Handing the conflicts to an agent…").font(.caption)
                case .needsConfirm(let reason):
                    Text("\(reason) Send anyway?").font(.caption)
                    Button("Send anyway") { bar.resolveConflicts(confirm: true) }
                    Button("Cancel") { bar.cancelConflictStep() }
                case .done(let handOff):
                    Text(handOffMessage(handOff)).font(.caption)
                    Button("Open workspace") { workspace.page.app.openWorkspace(id: handOff.workspaceId) }
                    Button("Send again") { bar.askSendAgain() }
                case .confirmAgain:
                    Text("Send the instructions again?").font(.caption)
                    Button("Yes, send again") { bar.resolveConflicts(confirm: true) }
                    Button("Cancel") { bar.cancelConflictStep() }
                }
            }
            .controlSize(.small)
            if let error = bar.conflictError { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
    }
}

private struct ReviewNewCommitsBanner: View {
    let workspace: ReviewWorkspaceModel
    let pr: ReviewPrModel
    @Bindable var bar: ReviewPrBarModel

    var body: some View {
        let providerHead = pr.status.value?.headSha
        Group {
            switch bar.refreshPhase {
            case .refreshing(let line):
                row(line.map { "Updating the checkout · \($0)" } ?? "Updating the checkout…", tint: .blue) {}
            case .failed(let error):
                row("Update failed: \(error)", tint: .red) {
                    Button("Dismiss") { bar.dismissRefresh() }
                }
            case .done(let target) where target == nil || providerHead == nil || target == providerHead
                || !hasNewCommits(pr.pr, providerHead: providerHead):
                row("Checkout updated to the latest commits. Your tabs now show them.", tint: .green) {
                    Button("See what changed since you last reviewed") {
                        workspace.openTab(ReviewTabSpec(kind: .sinceReview, prId: pr.prId))
                        bar.dismissRefresh()
                    }
                    Button("Dismiss") { bar.dismissRefresh() }
                }
            default:
                if hasNewCommits(pr.pr, providerHead: providerHead), let head = providerHead {
                    row("New commits pushed — the PR is at \(head.prefix(7)), this checkout at "
                        + "\(pr.pr.headSha?.prefix(7) ?? "").", tint: .blue) {
                        Button("Refresh") { bar.refreshCheckout() }
                    }
                }
            }
        }
    }

    private func row(_ text: String, tint: Color, @ViewBuilder actions: () -> some View) -> some View {
        HStack {
            Text(text).font(.caption).lineLimit(2)
            Spacer()
            actions()
        }
        .controlSize(.small)
        .padding(6)
        .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
    }
}
