import SwiftUI
import YarvisClient

/// Posting one finding: to the PR as a line comment, or into the linked
/// Yarvis workspace's own review comments.
enum ReviewPostState: Equatable {
    case posting
    case postedToPr(onFile: Bool)
    case added
    case failed(String)
}

/// What the report view needs beyond the report: where links go, what is
/// current, and how findings get posted.
@MainActor
struct ReviewReportContext {
    let context: ReviewTabContext
    let model: ReviewVerificationModel
    /// Sections whose result is for the PR's head; only those offer Post buttons.
    let currentSections: Set<String>
    let upstack: VerificationUpstack?

    var links: ReviewLinks { ReviewLinks(context: context) }

    /// The report may name any file; only one the PR has becomes a link.
    func canOpen(_ path: String) -> Bool {
        links.changed.contains(path) || links.tree.contains(path)
    }

    func open(_ path: String, _ line: Int?) {
        links.open(path, line: line)
    }

    var viewed: Set<String> { context.pr.viewed ?? [] }
}

/// The checklist's report: each section's newest result, in report order.
/// Everything in it is model-written, so it is plain text.
struct ReviewReportView: View {
    let report: VerificationReport
    let ctx: ReviewReportContext

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            coverage
            if let summary = report.summary {
                section("Summary", "summary") { Text(summary).textSelection(.enabled) }
            }
            if let mustRead = report.mustRead, !mustRead.isEmpty { mustReadSection(mustRead) }
            if let map = report.changeMap { changeMapSection(map) }
            if let claims = report.claims { claimsSection(claims) }
            if let risk = report.risk { riskSection(risk) }
            if let approach = report.approach { approachSection(approach) }
            checksSection
        }
    }

    private func title(_ text: String, _ key: String) -> String {
        ctx.currentSections.contains(key) ? text : "\(text) · older head"
    }

    private func section<C: View>(_ text: String, _ key: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ReviewSectionTitle(title(text, key))
            content()
        }
    }

    private func location(_ path: String?, _ line: Int?, suffix: String? = nil) -> some View {
        Group {
            if let path {
                ReviewPathLink(path: path, line: line, suffix: suffix, canOpen: ctx.canOpen(path)) { ctx.open(path, line) }
                    .opacity(ctx.viewed.contains(path) ? 0.55 : 1)
            }
        }
    }

    private func rangeSuffix(_ r: LineRange?) -> String? {
        r.map { $0.start == $0.end ? ":\($0.start)" : ":\($0.start)–\($0.end)" }
    }

    // MARK: Coverage

    @ViewBuilder private var coverage: some View {
        if let c = report.coverage {
            if !c.isKnown {
                Text("Yarvis couldn't count which files the checks read, so this report may not cover every changed file.")
                    .font(.caption).foregroundStyle(.orange)
            } else {
                let notExamined = c.notExamined ?? []
                let skimmed = c.skimmed ?? []
                VStack(alignment: .leading, spacing: 4) {
                    if !notExamined.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Not examined").font(.caption.weight(.semibold))
                            ForEach(Array(notExamined.prefix(6).enumerated()), id: \.offset) { _, n in
                                HStack(spacing: 6) { location(n.path, nil); Text(n.reason).font(.caption) }
                            }
                            if notExamined.count > 6 { Text("\(notExamined.count - 6) more").font(.caption) }
                        }
                        .padding(8)
                        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
                    } else {
                        Text("At least one check read each of the \(c.total ?? 0) files to read\(skimmed.isEmpty ? "" : ", and skimmed \(skimmed.count) files").")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(c.laneGaps ?? [], id: \.self) { gap in
                        Text("Not examined by \(verificationCheckLabels[gap.check] ?? gap.check): \(gap.paths.joined(separator: ", "))")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    if !skimmed.isEmpty {
                        ReviewFold(title: "Generated, skimmed: \(skimmed.count) files") {
                            ForEach(skimmed, id: \.self) { s in
                                Text("\(s.path) (\(s.kind))").font(.caption.monospaced())
                            }
                        }
                    }
                }
            }
        } else {
            Text("This report doesn't record which files its checks read. Re-run it to find out.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: Summary and change map

    private func mustReadSection(_ mustRead: [VerificationMustRead]) -> some View {
        let viewedCount = mustRead.filter { ctx.viewed.contains($0.path) }.count
        return VStack(alignment: .leading, spacing: 6) {
            ReviewSectionTitle(title("Must read · \(viewedCount) of \(mustRead.count) viewed", "summary"))
            ForEach(mustRead, id: \.self) { m in
                VStack(alignment: .leading, spacing: 2) {
                    location(m.path, m.lines?.start, suffix: rangeSuffix(m.lines))
                    Text(m.reason).font(.callout).strikethrough(ctx.viewed.contains(m.path))
                    ForEach(Array((m.flags ?? []).enumerated()), id: \.offset) { _, f in
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text("?").foregroundStyle(.orange).bold()
                            Text(f.note).font(.caption)
                            if let line = f.line { location(m.path, line) }
                        }
                    }
                }
                .textSelection(.enabled)
            }
        }
    }

    private func changeMapSection(_ map: VerificationChangeMap) -> some View {
        section("Change map", "changeMap") {
            if !map.intent.isEmpty { Text(map.intent).font(.callout).textSelection(.enabled) }
            ForEach(Array(map.themes.enumerated()), id: \.offset) { _, t in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Chip(text: t.cohesion.capitalized, color: t.cohesion == "outlier" ? .orange : t.cohesion == "core" ? .blue : .secondary)
                        Chip(text: "\(t.risk) risk", color: reportRiskColor(t.risk))
                        Text(t.title).font(.callout.weight(.medium))
                    }
                    if !t.description.isEmpty { Text(t.description).font(.callout) }
                    ReviewWrapRow(t.files.map { f in AnyView(location(f.path, f.lines?.start, suffix: rangeSuffix(f.lines))) })
                    if t.cohesion == "outlier", !t.question.isEmpty {
                        Text("Ask the author: \(t.question)").font(.callout).foregroundStyle(.orange)
                        if let first = t.files.first {
                            ReviewPostButtons(ctx: ctx, section: "changeMap", source: "Change map", title: t.title, detail: t.question,
                                              severity: "medium", path: first.path, line: first.lines?.start ?? 1)
                        }
                    }
                }
                .textSelection(.enabled)
            }
            if !map.unmapped.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text("In no theme:").font(.caption).foregroundStyle(.secondary)
                    ReviewWrapRow(map.unmapped.map { AnyView(location($0, nil)) })
                }
            }
        }
    }

    // MARK: Claims and risk

    private func claimsSection(_ claims: VerificationClaims) -> some View {
        section("Claims", "claims") {
            if let tickets = claims.tickets, !tickets.isEmpty {
                HStack(spacing: 6) {
                    Text("Tickets:").font(.caption).foregroundStyle(.secondary)
                    ForEach(tickets, id: \.self) { t in
                        Button("\(t.key) \(t.title)") { openExternal(t.url) }.buttonStyle(.link).font(.caption).help(t.url)
                    }
                }
            }
            ForEach(claims.ticketNotes ?? [], id: \.self) { Text($0).font(.caption).foregroundStyle(.orange) }
            if claims.items.isEmpty { Text("No claims.").font(.caption).foregroundStyle(.secondary) }
            ForEach(Array(claims.items.enumerated()), id: \.offset) { _, c in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Chip(text: claimStatusLabels[c.status] ?? c.status, color: claimColor(c.status))
                        Text(c.claim).font(.callout)
                        Text(c.source).font(.caption).foregroundStyle(.secondary)
                    }
                    location(c.path, c.line)
                    if !c.evidence.isEmpty { Text(c.evidence).font(.caption).foregroundStyle(.secondary) }
                    if isUnmetClaim(c.status) {
                        ReviewPostButtons(ctx: ctx, section: "claims", source: "Claims: \(c.status)", title: c.claim,
                                          detail: c.evidence, severity: c.status == "partial" ? "medium" : "high",
                                          path: c.path, line: c.line)
                    }
                }
                .textSelection(.enabled)
            }
            if !claims.gaps.isEmpty {
                ReviewCheckFindings(ctx: ctx, label: "Unfinished work", section: "claims", findings: claims.gaps)
            }
        }
    }

    private func riskSection(_ risk: VerificationRisk) -> some View {
        section("Risk", "risk") {
            HStack(spacing: 6) {
                if let impact = risk.impact {
                    Chip(text: "\(impactLabels[impact.band] ?? "") impact · \(impact.band)/5", color: impact.band >= attentionBand ? .red : impact.band == 3 ? .orange : .green)
                }
                // The level shows beside the band only when the agent judged it differently.
                if risk.impact.map({ risk.level != riskLevel(forBand: $0.band) }) ?? true {
                    Chip(text: "\(risk.level) risk", color: reportRiskColor(risk.level))
                }
                Text(risk.clientImpact).font(.callout).textSelection(.enabled)
            }
            if let impact = risk.impact { impactDetail(impact) }
            if !risk.mitigations.isEmpty {
                Text("Mitigations").font(.caption).foregroundStyle(.secondary)
                ForEach(risk.mitigations, id: \.self) { Text("• \($0)").font(.caption).textSelection(.enabled) }
            }
            ForEach(Array(risk.concerns.enumerated()), id: \.offset) { _, c in
                VStack(alignment: .leading, spacing: 2) {
                    Text(c.title).font(.callout.weight(.medium))
                    location(c.path, c.line)
                    if !c.detail.isEmpty { Text(c.detail).font(.caption) }
                    ReviewPostButtons(ctx: ctx, section: "risk", source: "Risk", title: c.title, detail: c.detail,
                                      severity: nil, path: c.path, line: c.line)
                }
                .textSelection(.enabled)
            }
        }
    }

    private func impactDetail(_ impact: VerificationImpact) -> some View {
        let attention = impact.changes.filter { $0.band >= attentionBand }
        return VStack(alignment: .leading, spacing: 4) {
            Text(impactCountsText(impact.counts)
                + (impact.raisedByVolume > 0
                    ? " · raised from \(impactLabels[impact.highestChangeBand] ?? "\(impact.highestChangeBand)") by the number of changes, so splitting the PR would lower it" : ""))
                .font(.caption).foregroundStyle(.secondary)
            if !attention.isEmpty {
                Text("Needs attention").font(.caption).foregroundStyle(.secondary)
                ForEach(Array(attention.enumerated()), id: \.offset) { _, c in change(c, post: true) }
            }
            if !impact.changes.isEmpty {
                ReviewFold(title: "Every change (\(impact.changes.count))") {
                    ForEach(Array(impact.changes.enumerated()), id: \.offset) { _, c in change(c, post: false) }
                }
            }
        }
    }

    private func change(_ c: VerificationChange, post: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Chip(text: "\(c.band)/5", color: c.band >= attentionBand ? .red : .secondary)
                Text(c.title).font(.callout)
                location(c.path, c.line)
            }
            Text(describeChange(c)).font(.caption).foregroundStyle(.secondary)
            if !c.check.isEmpty { Text(c.check).font(.caption) }
            if post {
                ReviewPostButtons(ctx: ctx, section: "risk", source: "Risk", title: c.title, detail: c.check,
                                  severity: nil, path: c.path, line: c.line)
            }
        }
        .textSelection(.enabled)
    }

    private func approachSection(_ a: VerificationApproach) -> some View {
        section("Simpler approach", "approach") {
            Chip(text: approachLabels[a.rating] ?? a.rating,
                 color: a.rating == "much-simpler" ? .red : a.rating == "simpler" ? .orange : a.rating == "no-simpler" ? .green : .secondary)
            if !a.reason.isEmpty { Text(a.reason).font(.callout).textSelection(.enabled) }
            if !a.alternative.isEmpty {
                Text(a.alternative).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                location(a.path, a.line)
            }
        }
    }

    // MARK: Checks

    @ViewBuilder private var checksSection: some View {
        let present = VerificationSections.checks.filter { report.check($0) != nil }
        if !present.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ReviewSectionTitle("Checks")
                ForEach(present, id: \.self) { key in
                    let check = report.check(key)!
                    let label = title(verificationCheckLabels[key] ?? key, key)
                    if check.findings.isEmpty {
                        Text("✓ \(label) passes").font(.callout).foregroundStyle(.green)
                    } else {
                        ReviewFold(title: "\(label) (\(check.findings.count))", initiallyOpen: true) {
                            ReviewCheckFindings(ctx: ctx, label: verificationCheckLabels[key] ?? key, section: key,
                                                findings: check.findings)
                        }
                    }
                    if key == "malice", let tripwires = report.malice?.tripwires, !tripwires.isEmpty {
                        let omitted = report.malice?.tripwiresOmitted ?? 0
                        ReviewFold(title: "\(tripwires.count + omitted) tripwire\(tripwires.count + omitted == 1 ? "" : "s") to confirm") {
                            ForEach(Array(tripwires.enumerated()), id: \.offset) { _, t in
                                HStack(alignment: .firstTextBaseline, spacing: 6) {
                                    Text(tripwireLabels[t.kind] ?? t.kind).font(.caption).foregroundStyle(.secondary)
                                    location(t.path, t.line)
                                    Text(t.note).font(.caption).textSelection(.enabled)
                                }
                            }
                            if omitted > 0 { Text("\(omitted) more not listed.").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
            }
        }
    }
}

/// A check's findings, each with where it is, whether a stacked PR changes
/// that line, and the Post buttons.
private struct ReviewCheckFindings: View {
    let ctx: ReviewReportContext
    let label: String
    let section: String
    let findings: [VerificationFinding]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if section == "claims" { Text(label).font(.caption).foregroundStyle(.secondary) }
            ForEach(Array(findings.enumerated()), id: \.offset) { _, f in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Chip(text: f.severity, color: f.severity == "high" ? .red : f.severity == "medium" ? .orange : .secondary)
                        Text(f.title).font(.callout.weight(.medium))
                    }
                    if let path = f.path {
                        HStack(spacing: 6) {
                            ReviewPathLink(path: path, line: f.line, canOpen: ctx.canOpen(path)) { ctx.open(path, f.line) }
                                .opacity(ctx.viewed.contains(path) ? 0.55 : 1)
                            if let layer = changedUpstack(ctx.upstack, path: path, line: f.line) {
                                Button("changed in #\(layer.number) above") { openExternal(layer.url) }
                                    .buttonStyle(.link).font(.caption).help(layer.url)
                            }
                        }
                    }
                    if !f.detail.isEmpty { Text(f.detail).font(.caption) }
                    ReviewPostButtons(ctx: ctx, section: section, source: label, title: f.title, detail: f.detail,
                                      severity: f.severity, path: f.path, line: f.line)
                }
                .textSelection(.enabled)
            }
        }
    }
}

/// "Post to PR" and "Add to <workspace>" for one finding. Shown only for a
/// finding with a line, in a section whose result is for the PR's head.
struct ReviewPostButtons: View {
    let ctx: ReviewReportContext
    let section: String
    /// How the comment names where it came from.
    let source: String
    let title: String
    let detail: String
    let severity: String?
    let path: String?
    let line: Int?

    var body: some View {
        if ctx.currentSections.contains(section), let path, let line, line > 0 {
            let key = "\(section):\(path):\(line):\(title)"
            let body = findingCommentBody(title: title, detail: detail, severity: severity, section: source)
            let model = ctx.model
            HStack(spacing: 8) {
                switch model.posts[key] {
                case .postedToPr(let onFile)?:
                    Text("Posted to PR").font(.caption).foregroundStyle(.green)
                    if onFile {
                        Text("Posted on the whole file instead: GitHub only takes line comments on lines inside the diff.")
                            .font(.caption).foregroundStyle(.orange)
                    }
                case .added?:
                    Text("Added to \(model.linked?.name ?? "the workspace")").font(.caption).foregroundStyle(.green)
                case .posting?:
                    Text("Posting…").font(.caption).foregroundStyle(.secondary)
                default:
                    Button("Post to PR") { model.postToPr(key: key, path: path, line: line, body: body, ctx.context.pr) }
                        .buttonStyle(.link).font(.caption)
                    if let linked = model.linked {
                        Button("Add to \(linked.name)") { model.addToWorkspace(key: key, path: path, line: line, body: body) }
                            .buttonStyle(.link).font(.caption)
                    }
                    if case .failed(let error)? = model.posts[key] { ReviewErrorText(error) }
                }
            }
        }
    }
}

/// Lays out views left to right, wrapping onto new lines.
struct ReviewWrapRow: View {
    let items: [AnyView]

    init(_ items: [AnyView]) {
        self.items = items
    }

    var body: some View {
        WrapLayout(spacing: 8) {
            ForEach(items.indices, id: \.self) { items[$0] }
        }
    }
}

private struct WrapLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                y += rowHeight + 4
                x = 0
                rowHeight = 0
            }
            x += size.width + spacing
            widest = max(widest, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: min(widest, width), height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += rowHeight + 4
                x = bounds.minX
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

func reportRiskColor(_ level: String) -> Color {
    level == "high" ? .red : level == "medium" ? .orange : .green
}

private func claimColor(_ status: String) -> Color {
    switch status {
    case "verified": return .green
    case "partial": return .orange
    case "missing", "contradicted": return .red
    default: return .secondary
    }
}
