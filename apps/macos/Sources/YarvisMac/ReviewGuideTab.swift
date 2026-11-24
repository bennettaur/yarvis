import SwiftUI
import YarvisClient

/// One PR's guided review: the guide, the step being read, and a
/// generation in flight. Kept per PR so a slow generation survives switching tabs.
@MainActor @Observable
final class ReviewGuideModel {
    private let client: YarvisClient
    let ref: PrRef

    private(set) var guide: PrGuide?
    private(set) var step = 0
    private(set) var loading = false
    private(set) var loaded = false
    private(set) var generating = false
    var error: String?

    init(client: YarvisClient, ref: PrRef) {
        self.client = client
        self.ref = ref
    }

    func load() {
        guard !loaded, !loading else { return }
        loading = true
        Task {
            do {
                guide = try await client.prGuide(ref)
                step = guide.map { min(max($0.currentStep, 0), max($0.steps.count - 1, 0)) } ?? 0
                error = nil
                loaded = true
            } catch {
                self.error = reviewErrorText(error)
            }
            loading = false
        }
    }

    /// A slow agent run, about a minute, with no stream to follow.
    func generate(title: String?) {
        generating = true
        error = nil
        Task {
            do {
                let fresh = try await client.generatePrGuide(ref, title: title)
                guide = fresh
                step = 0
                loaded = true
            } catch {
                self.error = reviewErrorText(error)
            }
            generating = false
        }
    }

    /// Moves to step `index` (clamped), saves the place and opens its code.
    func goTo(_ index: Int, _ context: ReviewTabContext) {
        guard let guide, !guide.steps.isEmpty else { return }
        step = min(max(index, 0), guide.steps.count - 1)
        let (client, ref, step) = (client, ref, step)
        // Fire and forget: a lost save only means the guide reopens a step back.
        Task { _ = try? await client.setPrGuideProgress(ref, step: step) }
        let s = guide.steps[step]
        focus(path: s.path, line: s.startLine, context)
    }

    func next(_ context: ReviewTabContext) {
        guard let current = currentStep else { return }
        context.pr.setViewed(current.paths, true)
        goTo(step + 1, context)
    }

    func back(_ context: ReviewTabContext) {
        goTo(step - 1, context)
    }

    func finish(_ context: ReviewTabContext) {
        if let current = currentStep { context.pr.setViewed(current.paths, true) }
        dismiss()
    }

    func dismiss() {
        guide = nil
        step = 0
        let (client, ref) = (client, ref)
        Task {
            do {
                try await client.deletePrGuide(ref)
            } catch {
                self.error = reviewErrorText(error)
            }
        }
    }

    /// Opens a location without changing the step.
    func focus(path: String, line: Int?, _ context: ReviewTabContext) {
        ReviewLinks(context: context).open(path, line: line)
    }

    var currentStep: PrGuideStep? {
        guard let guide, guide.steps.indices.contains(step) else { return nil }
        return guide.steps[step]
    }
}

struct ReviewGuideTab: View {
    let context: ReviewTabContext

    private var model: ReviewGuideModel {
        let pr = context.pr
        return ReviewTabModels.get(context) { ReviewGuideModel(client: context.client, ref: pr.ref) }
    }

    var body: some View {
        let model = model
        Group {
            if let guide = model.guide, !guide.steps.isEmpty {
                HSplitView {
                    stepList(model, guide)
                        .frame(minWidth: 200, idealWidth: 280, maxWidth: 360)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            ReviewGuidePanel(model: model, guide: guide, context: context)
                            if let graph = guide.graph, !graph.nodes.isEmpty {
                                ReviewFlowGraphSection(graph: graph, stale: guide.stale)
                            }
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            } else {
                emptyState(model)
            }
        }
        .onAppear {
            model.load()
            context.pr.loadViewed()
            context.pr.loadChangedFiles()
        }
    }

    private func stepList(_ model: ReviewGuideModel, _ guide: PrGuide) -> some View {
        let viewed = context.pr.viewed ?? []
        return List(Array(guide.steps.enumerated()), id: \.offset) { i, step in
            Button {
                model.goTo(i, context)
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if step.paths.allSatisfy(viewed.contains) {
                        Image(systemName: "checkmark").foregroundStyle(.green).frame(width: 20)
                    } else {
                        Text("\(i + 1)").monospacedDigit().foregroundStyle(.secondary).frame(width: 20)
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(guideStepLocation(step)).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                        if let kind = step.kind, kind != "walkthrough" {
                            Text("\(kind) check").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .listRowBackground(i == model.step ? Color.accentColor.opacity(0.15) : Color.clear)
        }
    }

    @ViewBuilder private func emptyState(_ model: ReviewGuideModel) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if model.loading {
                ReviewWaiting("Loading the guide…")
            } else {
                Text("A guided review reads the change and works out an order to read it in, with a note at each stop on why it comes there.")
                    .foregroundStyle(.secondary)
                if model.generating {
                    ReviewWaiting("Working out a reading order…")
                    Text("Reading the change to work out where to start — this takes a minute.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Button("Guided review") { model.generate(title: context.pr.pr.title) }
                }
            }
            if let error = model.error { ReviewErrorText(error) }
        }
        .padding(16)
        .frame(maxWidth: 640, maxHeight: .infinity, alignment: .topLeading)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

/// The step being read: why it comes here, what else it covers, what the
/// agent flagged, and the way on.
private struct ReviewGuidePanel: View {
    let model: ReviewGuideModel
    let guide: PrGuide
    let context: ReviewTabContext
    @State private var showCovers = false

    var body: some View {
        if let step = model.currentStep {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text("Step \(model.step + 1) of \(guide.steps.count)").font(.headline)
                    if let label = step.kind.flatMap({ guideStepKindLabels[$0] }) { Chip(text: label, color: .purple) }
                    if guide.stale {
                        Chip(text: "Out of date", color: .orange,
                             help: "Generated against \(reportSha(guide.headSha)); the pull request has moved since.")
                    }
                    Spacer()
                    Button(model.generating ? "Rebuilding…" : "Regenerate") { model.generate(title: context.pr.pr.title) }
                        .disabled(model.generating)
                    Button { model.dismiss() } label: { Image(systemName: "xmark") }
                        .help("End guided review")
                        .buttonStyle(.borderless)
                }
                Button(guideStepLocation(step)) { model.goTo(model.step, context) }
                    .buttonStyle(.link)
                    .font(.callout.monospaced())
                Text(step.explanation).textSelection(.enabled)
                if let covers = step.covers?.filter({ $0 != step.path }), !covers.isEmpty {
                    DisclosureGroup(isExpanded: $showCovers) {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(covers, id: \.self) { path in
                                Button(path) { model.focus(path: path, line: nil, context) }
                                    .buttonStyle(.link).font(.caption.monospaced())
                            }
                        }
                    } label: {
                        Text("covers \(covers.count) \(covers.count == 1 ? "file" : "files")").font(.caption)
                    }
                }
                if let findings = step.findings, !findings.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(findings.enumerated()), id: \.offset) { _, f in
                            Button {
                                model.focus(path: f.path, line: f.startLine, context)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(spacing: 6) {
                                        Chip(text: guideFindingKindLabels[f.kind] ?? f.kind, color: .orange)
                                        Text(f.startLine.map { "\(f.path):\($0)" } ?? f.path)
                                            .font(.caption.monospaced()).foregroundStyle(.secondary)
                                    }
                                    Text(f.note).font(.callout).multilineTextAlignment(.leading)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                if let more = step.context, !more.isEmpty {
                    ReviewFold(title: "More context") { Text(more).font(.callout).textSelection(.enabled) }
                }
                if let error = model.error { ReviewErrorText(error) }
                HStack {
                    Button("Back") { model.back(context) }.disabled(model.step == 0)
                    Spacer()
                    if model.step == guide.steps.count - 1 {
                        Button("Finish") { model.finish(context) }
                    } else {
                        Button("Next") { model.next(context) }
                    }
                }
            }
        }
    }
}
