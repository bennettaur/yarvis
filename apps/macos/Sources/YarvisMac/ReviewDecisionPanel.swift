import SwiftUI
import YarvisClient

/// The suggested decision with its reasons, and the forms that act on it.
struct ReviewDecisionPanel: View {
    let context: ReviewTabContext
    let model: ReviewVerificationModel
    let assessment: ReviewAssessment
    let report: VerificationReport?
    let evidence: [EvidenceItem]?
    let currentSections: Set<String>

    private enum Mode: String, CaseIterable {
        case approve = "Approve"
        case requestChanges = "Request changes"
        case reviewDeeper = "Review deeper"
    }

    @State private var mode: Mode?

    private var pr: ReviewPrModel { context.pr }

    var body: some View {
        let drafts = draftComments(report: report, evidence: evidence, currentSections: currentSections)
        let postedIds = model.postedIds(head: pr.pr.headSha ?? "")
        let busy = model.deciding
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Chip(text: assessment.suggestion.label, color: suggestionColor)
                if let intent = report?.changeMap?.intent ?? report?.summary {
                    Text(intent).font(.callout).lineLimit(2).textSelection(.enabled)
                }
                Spacer()
                ForEach(Mode.allCases, id: \.self) { m in
                    Toggle(m.rawValue, isOn: Binding(get: { mode == m }, set: { on in
                        model.clearDecisionMessages()
                        mode = on ? m : nil
                    }))
                    .toggleStyle(.button)
                }
            }
            reasons
            switch mode {
            case .approve?:
                ReviewApproveForm(assessment: assessment, busy: busy) { model.approve($0, pr: pr) { mode = nil } }
            case .requestChanges?:
                ReviewRequestChangesForm(drafts: drafts, posted: postedIds, busy: busy) {
                    model.requestChanges($0, summary: $1, pr: pr) { mode = nil }
                }
            case .reviewDeeper?: whereToLookList
            case nil: EmptyView()
            }
            if let error = model.decisionError { ReviewErrorText(error) }
            if let done = model.decisionDone { Text(done).font(.callout).foregroundStyle(.green) }
        }
        .padding(12)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.25)))
    }

    private var suggestionColor: Color {
        switch assessment.suggestion {
        case .approve: return .green
        case .requestChanges: return .red
        case .reviewDeeper: return .orange
        case .runChecks: return .secondary
        }
    }

    @ViewBuilder private var reasons: some View {
        if assessment.blockers.isEmpty && assessment.concerns.isEmpty && assessment.notRun.isEmpty {
            Text("CI passed, and the claims and checks found nothing that blocks this PR.").font(.caption)
                .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(assessment.blockers.enumerated()), id: \.offset) { Text("• \($1)").foregroundStyle(.red) }
                ForEach(Array(assessment.concerns.enumerated()), id: \.offset) { Text("• \($1)").foregroundStyle(.orange) }
                if !assessment.notRun.isEmpty {
                    Text("• Not run on this commit: \(assessment.notRun.joined(separator: ", "))").foregroundStyle(.secondary)
                }
            }
            .font(.caption)
            .textSelection(.enabled)
        }
    }

    @ViewBuilder private var whereToLookList: some View {
        let places = whereToLook(report)
        if places.isEmpty {
            Text("Run the change map, summary or checks to see where to look first.").font(.caption).foregroundStyle(.secondary)
        } else {
            let links = ReviewLinks(context: context)
            let known = links.changed.union(links.tree)
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(places.enumerated()), id: \.offset) { _, p in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        ReviewPathLink(path: p.path, line: p.line, canOpen: known.contains(p.path)) { links.open(p.path, line: p.line) }
                        Text(p.reason).font(.caption).textSelection(.enabled)
                    }
                }
            }
        }
    }
}

private struct ReviewApproveForm: View {
    let assessment: ReviewAssessment
    let busy: Bool
    let submit: (String) -> Void
    @State private var text = ""

    var body: some View {
        let raised = assessment.blockers.count + assessment.concerns.count
        let notRun = assessment.notRun.count
        VStack(alignment: .leading, spacing: 6) {
            if raised + notRun > 0 {
                Text((raised > 0 ? "The report raised \(raised == 1 ? "one thing" : "\(raised) things") above. " : "")
                    + (notRun > 0 ? "\(notRun == 1 ? "One check hasn't" : "\(notRun) checks haven't") run on this commit. " : "")
                    + "Approve only if you've looked for yourself.")
                    .font(.caption).foregroundStyle(.orange)
            }
            TextField("Optional comment for the author", text: $text, axis: .vertical)
                .lineLimit(2...6)
                .accessibilityLabel("Approval comment")
            Button(busy ? "Approving…" : "Submit approval") { submit(text) }.disabled(busy)
        }
    }
}

private struct ReviewRequestChangesForm: View {
    let drafts: [DraftComment]
    let posted: Set<String>
    let busy: Bool
    let submit: ([DraftComment], String) -> Void
    @State private var ticks: [String: Bool] = [:]
    @State private var edits: [String: String] = [:]
    @State private var typedSummary: String?

    var body: some View {
        let isPicked = { (d: DraftComment) in ticks[d.id] ?? d.pickedByDefault }
        let chosen = drafts.filter(isPicked).map { d -> DraftComment in
            var d = d
            d.body = edits[d.id] ?? d.body
            return d
        }
        let summary = typedSummary ?? reviewSummary(chosen)
        VStack(alignment: .leading, spacing: 8) {
            if drafts.isEmpty {
                Text("The report has nothing to raise. Say what needs changing in the summary below.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(drafts) { d in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Toggle("", isOn: Binding(get: { isPicked(d) }, set: { ticks[d.id] = $0 }))
                            .labelsHidden()
                            .disabled(posted.contains(d.id))
                            .accessibilityLabel("Include \(d.title)")
                        Text(d.severity.uppercased()).font(.caption2).foregroundStyle(.secondary)
                        Text(d.title).font(.callout).lineLimit(2)
                        Text(d.source).font(.caption).foregroundStyle(.secondary)
                        if let path = d.path, let line = d.line {
                            Text("\(path):\(line)").font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                        } else {
                            Text("in the summary").font(.caption).foregroundStyle(.secondary)
                        }
                        if posted.contains(d.id) { Text("posted").font(.caption).foregroundStyle(.green) }
                    }
                    if isPicked(d) && !posted.contains(d.id) {
                        TextEditor(text: Binding(get: { edits[d.id] ?? d.body }, set: { edits[d.id] = $0 }))
                            .font(.caption.monospaced())
                            .frame(minHeight: 60, maxHeight: 140)
                            .accessibilityLabel("Comment on \(d.title)")
                    }
                }
            }
            HStack {
                Text("Review summary").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if typedSummary != nil {
                    Button("Draft the summary again from what's ticked") { typedSummary = nil }.buttonStyle(.link).font(.caption)
                }
            }
            TextEditor(text: Binding(get: { summary }, set: { typedSummary = $0 }))
                .font(.callout)
                .frame(minHeight: 80, maxHeight: 200)
                .accessibilityLabel("Review summary")
            Button(busy ? "Requesting changes…" : "Request changes\(chosen.isEmpty ? "" : " (\(chosen.count))")") {
                submit(chosen, summary)
            }
            .disabled(busy || summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }
}
