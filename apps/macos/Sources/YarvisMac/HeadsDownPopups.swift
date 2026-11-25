import SwiftUI
import YarvisClient

extension View {
    /// Heads-down mode's sheets over any page: a merge held for review
    /// feedback, a merge it made, and the question dialog opened from the bell.
    func headsDownPopups() -> some View {
        modifier(HeadsDownPopups())
    }
}

/// One sheet for all of them, since a window shows one sheet at a time;
/// `HeadsDownPopup.choose` picks which.
private struct HeadsDownPopups: ViewModifier {
    @Environment(AppModel.self) private var app

    func body(content: Content) -> some View {
        content.sheet(item: Binding(get: { app.headsDown?.popup }, set: { if $0 == nil { closed() } })) { popup in
            if let model = app.headsDown {
                switch popup {
                case .review(let item, let review, let remaining):
                    // Keyed on the item, so the next held merge arms afresh.
                    HeadsDownMergeReviewSheet(model: model, item: item, review: review, remaining: remaining)
                        .id(item.id)
                case .merge(let item, let merge, let remaining):
                    HeadsDownMergeAlertSheet(model: model, item: item, merge: merge, remaining: remaining)
                        .id(item.id)
                case .questions:
                    HeadsDownQuestionDialog(model: model)
                }
            }
        }
    }

    /// The sheet went away without one of its buttons; only the question dialog closes that way.
    private func closed() {
        if case .questions? = app.headsDown?.popup { app.headsDown?.closeQuestions() }
    }
}

// MARK: - The question dialog

/// Answers heads-down mode's questions and approvals without leaving the
/// current page.
private struct HeadsDownQuestionDialog: View {
    let model: HeadsDownModel

    var body: some View {
        let dialog = model.questionFlow
        let current = dialog?.current
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Heads down").font(.headline)
                Spacer()
                if let count = dialog?.questions?.count, count > 1 {
                    Text("\(count) waiting").font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding()
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let error = dialog?.error { Text(error).font(.caption).foregroundStyle(.red) }
                    if dialog?.questions == nil, dialog?.error == nil {
                        ProgressView().controlSize(.small)
                    } else if dialog?.questions != nil, current == nil {
                        Text("Heads-down mode isn't waiting on you any more.").font(.caption).foregroundStyle(.secondary)
                    }
                    if let current {
                        // A fresh card per question, so a typed answer never carries over; inert
                        // for a moment, so a click aimed at the last prompt can't answer this one.
                        HeadsDownQuestionCard(model: model, question: current) { model.dialogAnswered() }
                            .id(current.id)
                            .armedAfterAppearing(id: current.id)
                            .disabled(dialog?.reloading == true)
                    }
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack {
                Button("Open Heads down") { model.openPageFromDialog() }.buttonStyle(.link)
                Spacer()
                Button("Close") { model.closeQuestions() }.keyboardShortcut(.cancelAction)
            }
            .padding()
        }
        .environment(\.workspaceNames, model.workspaceNames)
        .environment(\.openURL, OpenURLAction { url in
            MainActor.assumeIsolated { model.openLink(url) }
            return .handled
        })
        .frame(width: 560)
        .frame(minHeight: 240, maxHeight: 640)
    }
}

// MARK: - Merges

/// How long a merge pop-up ignores clicks and Return after it appears over
/// whatever the user is doing, so input already on its way can't answer it.
private let mergePopupArmingDelay: Duration = .milliseconds(1200)

/// Pops up over any page when heads-down mode merges a PR. The merge doesn't
/// wait on the user; this makes sure they notice it. Got it, or Escape,
/// dismisses the attention item behind it.
private struct HeadsDownMergeAlertSheet: View {
    let model: HeadsDownModel
    let item: AttentionItem
    let merge: MergeAnnouncement
    let remaining: Int
    @State private var armed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("HEADS DOWN IS MERGING A PR").font(.caption.weight(.semibold)).foregroundStyle(.orange)
                        Text(merge.label).font(.title3.weight(.semibold))
                        if let title = merge.title {
                            (Text("PR title: ").foregroundColor(.secondary) + Text(title)).font(.callout)
                        }
                    }
                    Spacer()
                    HeadsDownRiskBadge(risk: merge.risk)
                }
                Text(merge.why).textSelection(.enabled)
                if remaining > 0 {
                    Text("\(remaining) more merge\(remaining > 1 ? "s" : "") to look at.").font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(20)
            Divider()
            HStack {
                Spacer()
                Button(openLabel) { model.openMerge(item) }
                // Return answers only once armed: the alert pops up over whatever
                // the user is typing in.
                Button("Got it") { model.dismissMerge(item) }
                    .keyboardShortcut(armed ? .defaultAction : nil)
            }
            .padding()
        }
        .onExitCommand { model.dismissMerge(item) }
        .task {
            try? await Task.sleep(for: mergePopupArmingDelay)
            armed = true
        }
        .frame(width: 520)
        .accessibilityLabel("Heads down is merging \(merge.label)")
    }

    private var openLabel: String {
        switch item.navTarget?["type"]?.stringValue {
        case "pr": return "Open PR"
        case "workspace": return "Open workspace"
        default: return "Open Heads down"
        }
    }
}

private struct HeadsDownRiskBadge: View {
    let risk: MergeRisk

    var body: some View {
        Text(risk.label).font(.caption.weight(.medium))
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .overlay(Capsule().strokeBorder(color.opacity(0.6)))
            .foregroundStyle(color)
    }

    private var color: Color {
        switch risk {
        case .high: return .red
        case .medium: return .orange
        case .low: return .green
        case .unknown: return .secondary
        }
    }
}

/// Asks the user about a merge heads-down mode held back because the PR has
/// open review feedback. Approve lets the merge run on the next pass. Review
/// denies it and opens the PR. Escape puts it away for now; it still waits
/// under Needs you.
private struct HeadsDownMergeReviewSheet: View {
    let model: HeadsDownModel
    let item: AttentionItem
    let review: MergeReview
    let remaining: Int
    @State private var armed = false
    @State private var busy = false
    @State private var error: String?
    @FocusState private var reviewFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(review.heading.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.orange)
                    if let unchecked = review.unchecked {
                        Text("It couldn't check the PR for open review feedback: \(unchecked)")
                    }
                    ForEach(review.prs, id: \.number) { HeadsDownPrFeedbackView(pr: $0) }
                    if let error { Text(error).foregroundStyle(.red) }
                    if remaining > 0 {
                        Text("\(remaining) more merge\(remaining > 1 ? "s" : "") waiting on you.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack {
                Button("Later") { model.deferReview(item) }
                    .keyboardShortcut(.cancelAction)
                    .help("Put this away for now; it still waits under Needs you")
                Spacer()
                // Focus starts on Review, so Return can't approve a merge by accident.
                Group {
                    Button("Review, don't merge") { answer(approve: false) }
                        .focused($reviewFocused)
                    Button("Approve merge") { answer(approve: true) }
                        .buttonStyle(.borderedProminent)
                        .tint(.orange)
                }
                .disabled(busy || !armed)
            }
            .padding()
        }
        .frame(width: 600)
        .frame(minHeight: 260, maxHeight: 700)
        .accessibilityLabel("Heads down wants to merge \(review.label)")
        .task {
            try? await Task.sleep(for: mergePopupArmingDelay)
            armed = true
            reviewFocused = true
        }
    }

    private func answer(approve: Bool) {
        busy = true
        error = nil
        Task {
            do {
                // Stays busy on success: the item goes once the bell hears it was answered.
                try await model.answer(review, approve: approve)
            } catch {
                self.error = error.localizedDescription
                busy = false
            }
        }
    }
}

private struct HeadsDownPrFeedbackView: View {
    let pr: PrFeedback

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(pr.repo)#\(pr.number)").font(.title3.weight(.semibold))
                if let title = pr.title {
                    (Text("PR title: ").foregroundColor(.secondary) + Text(title)).font(.callout)
                }
                Text(pr.handoffNote).font(.caption).foregroundStyle(.secondary)
            }
            if !pr.changesRequestedBy.isEmpty {
                Text("Changes requested by \(pr.changesRequestedBy.joined(separator: ", "))").foregroundStyle(.red)
            }
            ForEach(Array(pr.threads.enumerated()), id: \.offset) { _, thread in
                VStack(alignment: .leading, spacing: 4) {
                    Text(thread.heading).font(.caption).foregroundStyle(.secondary)
                    Text(thread.body).textSelection(.enabled)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
            }
            if let note = pr.moreThreadsNote { Text(note).font(.caption).foregroundStyle(.secondary) }
        }
    }
}
