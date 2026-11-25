import Observation
import SwiftUI
import YarvisClient

/// One artifact in the side pane, kept current from its change stream.
@MainActor @Observable
final class ChatArtifactModel {
    let id: String
    private let client: YarvisClient
    private(set) var artifact: Artifact?
    private(set) var deleted = false
    private(set) var error: String?
    private var task: Task<Void, Never>?

    init(id: String, client: YarvisClient) {
        self.id = id
        self.client = client
    }

    /// Reads the artifact on the first frame after every (re)connect and on
    /// each `updated`, since a change made while disconnected isn't replayed.
    func start() {
        task = Task {
            await fetch()
            while !Task.isCancelled, !deleted {
                do {
                    var first = true
                    for try await event in try client.artifactStream(id: id) {
                        switch event {
                        case .deleted:
                            markDeleted()
                        case .updated:
                            await fetch()
                        case .other:
                            if first { await fetch() }
                        }
                        first = false
                        if deleted { return }
                    }
                } catch YarvisError.http(status: 404, _, _) {
                    markDeleted()
                    return
                } catch {
                    if Task.isCancelled { return }
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func stop() {
        task?.cancel()
    }

    private func fetch() async {
        do {
            if let a = try await client.artifact(id: id) {
                artifact = a
                error = nil
            } else {
                markDeleted()
            }
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    private func markDeleted() {
        deleted = true
        artifact = nil
    }
}

struct ChatArtifactPane: View {
    let pane: ChatArtifactModel
    let chat: ChatModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "doc.richtext")
                Text(pane.artifact?.title ?? (pane.deleted ? "Artifact" : "Loading…")).font(.headline).lineLimit(1)
                if pane.artifact?.untrusted == true {
                    Text("untrusted").font(.caption2.bold()).padding(.horizontal, 5).padding(.vertical, 1)
                        .background(.orange.opacity(0.2), in: Capsule()).foregroundStyle(.orange)
                        .help("Written from content outside this chat. Its links don't move the app.")
                }
                Spacer()
                Button { chat.closeArtifact() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless).help("Close")
            }
            .padding(10)
            Divider()
            content
        }
        .frame(minWidth: 280, idealWidth: 420)
    }

    @ViewBuilder private var content: some View {
        if pane.deleted {
            Text("This artifact was deleted.").foregroundStyle(.secondary).padding()
            Spacer()
        } else if let a = pane.artifact {
            if a.format == "markdown" {
                ScrollView {
                    MarkdownText(a.content)
                        .environment(\.chatLinkRouter, ChatLinkRouter { chat.follow($0, fromUntrusted: a.untrusted) })
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                }
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("This is a \(a.format) drawing, which this app can't show.").foregroundStyle(.secondary)
                    Button("Open in web UI") { chat.app.showWebUI() }
                }
                .padding()
                Spacer()
            }
        } else if let error = pane.error {
            Text(error).foregroundStyle(.red).textSelection(.enabled).padding()
            Spacer()
        } else {
            ProgressView().padding()
            Spacer()
        }
    }
}
