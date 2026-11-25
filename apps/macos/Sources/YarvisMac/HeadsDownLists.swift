import SwiftUI
import YarvisClient

// MARK: - Work streams

/// The work streams heads-down mode is pushing, with what each is waiting on.
struct HeadsDownStreamList: View {
    let model: HeadsDownModel

    var body: some View {
        if let streams = model.streams, !streams.isEmpty {
            ForEach(streams) { HeadsDownStreamCard(model: model, stream: $0) }
        } else if model.streams == nil {
            Text("Loading…").foregroundStyle(.secondary)
        } else {
            Text("Nothing tracked yet. Plan the work in a chat and the assistant tracks each thread here.")
                .foregroundStyle(.secondary)
        }
    }
}

private struct HeadsDownStreamCard: View {
    let model: HeadsDownModel
    let stream: WorkStream
    @Environment(\.workspaceNames) private var names
    @State private var busy = false
    @State private var error: String?

    private var paused: Bool { stream.pausedAt != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        badge(workStreamStatusLabel(stream.status), statusColor)
                        if paused { badge("Paused", .blue) }
                        Text(stream.priority.uppercased()).font(.caption2).foregroundStyle(.secondary)
                    }
                    Text(stream.title).font(.callout.weight(.medium))
                }
                Spacer()
                HStack(spacing: 10) {
                    Button(paused ? "Resume" : "Pause") { patch(paused: !paused) }
                        .accessibilityLabel("\(paused ? "Resume" : "Pause") \(stream.title)")
                    Button("Done") { patch(status: "done") }
                        .accessibilityLabel("Mark \(stream.title) done")
                    Button("Drop") { patch(status: "dropped") }
                        .accessibilityLabel("Drop \(stream.title)")
                }
                .buttonStyle(.link)
                .font(.caption)
                .disabled(busy)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            if let waiting = stream.waitingOn {
                (Text("Waiting on: ") + Text(headsDownMentions(waiting, names: names))).font(.caption).foregroundStyle(.orange)
            }
            if let next = stream.nextAction {
                (Text("Next: ") + Text(headsDownMentions(next, names: names))).font(.caption).foregroundStyle(.secondary)
            }
            if isSnoozed(stream) {
                Text("Not before \(headsDownDateTime(stream.wakeAt))").font(.caption).foregroundStyle(.secondary)
            }
            if !stream.links.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(stream.links) { link($0) }
                }
                .padding(.top, 4)
            }
        }
        .headsDownCard()
    }

    @ViewBuilder private func link(_ link: WorkStreamLink) -> some View {
        let label = workStreamLinkLabel(link, workspaceNames: names) { $0.formatted(date: .abbreviated, time: .shortened) }
        Group {
            switch workStreamLinkTarget(link) {
            case .workspace(let id)?:
                Button(label) { model.openWorkspace(id) }.buttonStyle(.link)
            case .web(let url)?:
                Button(label) { openWebLink(url) }.buttonStyle(.link).help(url.absoluteString)
            case nil:
                Text(label)
            }
        }
        .font(.caption)
        .lineLimit(1)
        .truncationMode(.tail)
        .foregroundStyle(.secondary)
    }

    private var statusColor: Color {
        switch stream.status {
        case "active": return .green
        case "waiting-on-user": return .orange
        default: return .secondary
        }
    }

    private func badge(_ text: String, _ color: Color) -> some View {
        Text(text).font(.caption2)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(color.opacity(0.15), in: RoundedRectangle(cornerRadius: 3))
            .foregroundStyle(color)
    }

    private func patch(status: String? = nil, paused: Bool? = nil) {
        busy = true
        error = nil
        let id = stream.id
        Task {
            defer { busy = false }
            do {
                try await model.perform { try await $0.updateWorkStream(id: id, status: status, paused: paused) }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

// MARK: - Passes

/// What heads-down mode has been doing: the pass in flight, live, and the ones before it.
struct HeadsDownPassList: View {
    let model: HeadsDownModel

    var body: some View {
        let finished = finishedPasses(model.passes ?? [])
        VStack(alignment: .leading, spacing: 8) {
            if model.working { HeadsDownLivePassView(model: model) }
            if finished.isEmpty, !model.working {
                Text(model.passes == nil ? "Loading…" : "No passes yet.").foregroundStyle(.secondary)
            } else {
                ForEach(finished) { HeadsDownPassRow(model: model, pass: $0) }
            }
        }
    }
}

/// The pass in flight. The only view that reads it, so a streamed token
/// redraws this card and not the page.
private struct HeadsDownLivePassView: View {
    let model: HeadsDownModel

    var body: some View {
        if let live = model.livePass { card(live) }
    }

    private func card(_ live: LivePass) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                HeadsDownAgentMark(state: .working, size: 20)
                Text("Working now").font(.caption.weight(.medium)).foregroundStyle(.indigo)
                if !live.activity.isEmpty {
                    Text("· \(live.activity.count) tool call\(live.activity.count == 1 ? "" : "s")")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let error = live.error {
                Text(live.retrying ? "\(error) Trying again shortly." : error).font(.caption).foregroundStyle(.orange)
            }
            if !live.thought.isEmpty { HeadsDownLatestThought(text: live.thought, isThinking: live.isThinking) }
            ForEach(live.activity) { ToolCard(tool: $0) }
            if !model.liveBlocks.isEmpty { MarkdownText(blocks: model.liveBlocks).textSelection(.enabled) }
        }
        .headsDownCard(tint: .indigo)
    }
}

/// The latest thing the pass thought, folded to one line until opened.
private struct HeadsDownLatestThought: View {
    let text: String
    let isThinking: Bool
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { open.toggle() } label: {
                HStack(spacing: 6) {
                    Image(systemName: open ? "chevron.down" : "chevron.right").font(.caption2)
                    Text(isThinking ? "Thinking:" : "Last thought:")
                    if !open {
                        Text(firstLine(of: text))
                            .lineLimit(1)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                ScrollView {
                    Text(text).font(.caption.monospaced()).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 240)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(8)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
    }
}

/// One finished pass: what it left, how it ended, and its transcript one click away.
private struct HeadsDownPassRow: View {
    let model: HeadsDownModel
    let pass: HeadsDownPass
    @State private var open = false
    @State private var messages: [HeadsDownPassMessage]?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: toggle) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(headsDownDateTime(pass.startedAt))
                        if pass.error != nil { Text("failed").font(.caption).foregroundStyle(.red) }
                        if let calls = describeCalls(pass) { Text(calls).font(.caption).foregroundStyle(.secondary) }
                        Spacer()
                        Image(systemName: open ? "chevron.down" : "chevron.right").font(.caption2).foregroundStyle(.secondary)
                    }
                    if let sleep = describeSleep(pass) { Text(sleep).font(.caption).foregroundStyle(.secondary) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if let notes = pass.notes { MarkdownText(notes).font(.caption).foregroundStyle(.secondary) }
            if let failure = pass.error { Text(failure).font(.caption).foregroundStyle(.red.opacity(0.8)) }
            ForEach(Array((pass.failedCalls ?? []).enumerated()), id: \.offset) { _, call in
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(call.noResult == true ? "?" : "✕").foregroundStyle(call.noResult == true ? .orange : .red)
                    Text(describeFailedCall(call)).foregroundStyle(.secondary)
                }
                .font(.caption)
            }
            if open {
                Divider()
                transcript
            }
        }
        .headsDownCard()
    }

    @ViewBuilder private var transcript: some View {
        if let error {
            Text(error).font(.caption).foregroundStyle(.red)
        } else if let messages {
            // The first message is the prompt the pass started from; the rest is what it did.
            let replies = messages.filter { $0.role == "assistant" }
            if replies.isEmpty {
                Text("Nothing recorded for this pass.").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(replies) { m in
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(m.toolCalls ?? []) { ToolCard(tool: $0) }
                    if !m.content.isEmpty { MarkdownText(m.content).textSelection(.enabled) }
                }
            }
        } else {
            Text("Loading…").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func toggle() {
        open.toggle()
        guard open, messages == nil else { return }
        let id = pass.id
        Task {
            do {
                messages = try await model.passMessages(id)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

// MARK: - Auto-approvals

/// Calls the decision model approved on the user's behalf: each tool, when,
/// why, and with what arguments. This is the oversight for auto mode, so it
/// stays on the page rather than in a log.
struct HeadsDownAutoApprovals: View {
    let approvals: [HeadsDownQuestion]
    @State private var openId: String?

    var body: some View {
        ForEach(approvals) { approval in
            VStack(alignment: .leading, spacing: 4) {
                Button { openId = openId == approval.id ? nil : approval.id } label: {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(approval.action ?? "").font(.caption.monospaced())
                            if let answer = approval.answer { Text(answer).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        if let at = approval.answeredAt {
                            Text(headsDownDateTime(at)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if openId == approval.id {
                    Divider()
                    ScrollView {
                        Text(approval.toolArgs?.prettyPrinted ?? "null").font(.caption.monospaced())
                            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 180)
                }
            }
            .padding(8)
            .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
        }
    }
}

// MARK: - Routines

/// The routines passes take on, read-only: they are markdown files, so the
/// list names the folder to add one in and shows any file that failed to load.
struct HeadsDownRoutineList: View {
    let model: HeadsDownModel
    @State private var reloading = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let data = model.routines {
                ForEach(data.routines, id: \.name) { r in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(r.name).font(.caption.monospaced())
                                + Text(r.source == "user" ? " (yours)" : "").font(.caption).foregroundColor(.secondary)
                            Spacer()
                            Text(routineSchedule(r)).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(r.description).font(.caption).foregroundStyle(.secondary)
                        if r.enabled {
                            Text(r.lastDoneAt.flatMap(parseISODate).map {
                                "Last done \($0.formatted(.relative(presentation: .named)))"
                            } ?? "Not done in the last 30 days")
                            .font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                    .opacity(r.enabled ? 1 : 0.5)
                }
                ForEach(data.problems, id: \.path) { p in
                    Text(p.message).font(.caption).foregroundStyle(.orange)
                }
                Text("Add your own as markdown files in \(data.userDir). A file with the same name as one above replaces it.")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                reloadButton
            } else if let loadError = model.routinesError {
                Text("Couldn't load the routines: \(loadError)").font(.caption).foregroundStyle(.red)
                reloadButton
            } else {
                Text("Loading…").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var reloadButton: some View {
        HStack {
            Button("Reload files") {
                reloading = true
                error = nil
                Task {
                    defer { reloading = false }
                    do {
                        try await model.reloadRoutines()
                    } catch {
                        self.error = error.localizedDescription
                    }
                }
            }
            .buttonStyle(.link)
            .disabled(reloading)
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
    }
}
