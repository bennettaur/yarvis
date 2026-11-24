import SwiftUI
import YarvisClient

/// The comparison with the last review for one PR, kept across tab switches.
@MainActor @Observable
final class ReviewSinceReviewModel {
    private let client: YarvisClient
    let workspaceId: String
    let prId: String

    private(set) var since: SinceReview?
    private(set) var sinceFrom: String?
    private(set) var loading = false
    private(set) var error: String?
    private(set) var marking = false
    var markError: String?
    private var generation = 0

    init(client: YarvisClient, workspaceId: String, prId: String) {
        self.client = client
        self.workspaceId = workspaceId
        self.prId = prId
    }

    /// Reads the comparison from `from` to the checkout's `head`, unless it is already here.
    func load(from: String, head: String?) {
        let key = "\(from):\(head ?? "")"
        guard key != sinceFrom else { return }
        sinceFrom = key
        generation += 1
        let generation = generation
        loading = true
        error = nil
        Task {
            do {
                let next = try await client.sinceReview(workspaceId: workspaceId, prId: prId, from: from)
                guard generation == self.generation else { return }
                since = next
            } catch {
                guard generation == self.generation else { return }
                self.error = reviewErrorText(error)
                sinceFrom = nil
            }
            loading = false
        }
    }

    func markReviewed(_ pr: ReviewPrModel) {
        marking = true
        markError = nil
        Task {
            do {
                _ = try await client.markReviewedHere(workspaceId: workspaceId, prId: prId)
                pr.invalidateLastReview()
            } catch {
                markError = reviewErrorText(error)
            }
            marking = false
        }
    }
}

/// What the PR's own change did since the user last reviewed it.
struct ReviewSinceReviewTab: View {
    let context: ReviewTabContext

    private var pr: ReviewPrModel { context.pr }

    private var model: ReviewSinceReviewModel {
        ReviewTabModels.get(context) {
            ReviewSinceReviewModel(client: context.client, workspaceId: pr.workspaceId, prId: pr.prId)
        }
    }

    var body: some View {
        let model = model
        let last = pr.lastReview.value
        let mark = last?.mark
        let usable = mark != nil && last?.shaExists != false && last?.upToDate == false
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                content(model, last: last, usable: usable)
            }
            .padding(16)
            .frame(maxWidth: 820, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .onAppear {
            pr.loadLastReview()
            pr.loadDetail()
            pr.loadChangedFiles()
        }
        .task(id: usable ? "\(mark?.headSha ?? ""):\(pr.pr.headSha ?? "")" : "") {
            if usable, let from = mark?.headSha { model.load(from: from, head: pr.pr.headSha) }
        }
    }

    @ViewBuilder private func content(_ model: ReviewSinceReviewModel, last: LastReview?, usable: Bool) -> some View {
        if pr.pr.headSha == nil {
            Text("The pull request is still being fetched.").foregroundStyle(.secondary)
        } else if let error = pr.lastReview.error, last == nil {
            ReviewErrorText(error)
        } else if last == nil || (usable && model.since == nil && model.error == nil) {
            ReviewWaiting("Comparing with your last review…")
        } else if let last, !usable {
            noComparison(model, last)
        } else if let error = model.error {
            ReviewErrorText(error)
        } else if let since = model.since, let last {
            main(model, since, last)
        }
    }

    @ViewBuilder private func noComparison(_ model: ReviewSinceReviewModel, _ last: LastReview) -> some View {
        if let mark = last.mark {
            if last.shaExists == false {
                Text("The commit you reviewed (\(reportSha(mark.headSha))) can no longer be fetched, so there is nothing to compare with.")
            } else {
                Text("Nothing has changed since you reviewed \(reportSha(mark.headSha)).")
            }
        } else {
            Text("No review of this pull request is recorded yet. Submitting a review, posting a comment, or marking it reviewed here records where you were.")
        }
        if last.mark?.headSha != pr.pr.headSha { markButton(model) }
    }

    private func markButton(_ model: ReviewSinceReviewModel) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(model.marking ? "Marking…" : "Mark reviewed here") { model.markReviewed(pr) }
                .disabled(model.marking)
            if let error = model.markError { ReviewErrorText(error) }
        }
    }

    @ViewBuilder private func main(_ model: ReviewSinceReviewModel, _ since: SinceReview, _ last: LastReview) -> some View {
        Text("Since your last review").font(.headline)
        if let mark = last.mark {
            Text("You reviewed \(reportSha(mark.headSha)) \(markSourceText(mark, ref: pr.ref)) \(reviewRelativeTime(mark.createdAt)); the checkout is at \(reportSha(pr.pr.headSha)).")
                .font(.callout)
        }
        Text(sinceSummaryLine(since)).font(.callout).foregroundStyle(.secondary)
        if since.baseMoved {
            Text("Changes that came in from the base branch are left out: each file compares the PR's own change then and now.")
                .font(.caption).foregroundStyle(.secondary)
        }
        ReviewRereviewSummary(context: context, since: since)
        files(since)
        commits(since)
        VStack(alignment: .leading, spacing: 4) {
            Text("Done catching up? Marking moves the starting point to this checkout.").font(.caption).foregroundStyle(.secondary)
            markButton(model)
        }
    }

    @ViewBuilder private func files(_ since: SinceReview) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ReviewSectionTitle("Files", count: since.files.count)
            ForEach(since.files, id: \.path) { file in
                Button {
                    context.openTab(.sinceFile(prId: pr.prId, path: file.path, from: since.fromHeadSha))
                } label: {
                    HStack(spacing: 8) {
                        Text(sinceStatusLabels[file.status] ?? file.status)
                            .foregroundStyle(file.status == "added" ? .green : file.status == "reverted" ? .blue : .orange)
                            .frame(width: 100, alignment: .leading)
                        Text(file.path).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle).help(file.path)
                        Spacer()
                        if file.binary || file.tooLarge {
                            Text(file.binary ? "binary" : "too large").foregroundStyle(.secondary)
                        } else {
                            Text("+\(file.additions)").foregroundStyle(.green).font(.caption.monospaced())
                            Text("−\(file.deletions)").foregroundStyle(.red).font(.caption.monospaced())
                        }
                    }
                    .font(.caption)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if since.filesTruncated {
                Text("Line counts stop after the first 300 files.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private func commits(_ since: SinceReview) -> some View {
        let fresh = since.commits.filter(\.isNew)
        VStack(alignment: .leading, spacing: 4) {
            ReviewSectionTitle("New commits", count: fresh.count)
            if fresh.isEmpty {
                Text("None — the commits are the ones you saw.").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(fresh, id: \.sha) { commitRow($0, removed: false) }
            if !since.removedCommits.isEmpty {
                ReviewSectionTitle("Gone since your review", count: since.removedCommits.count).padding(.top, 6)
                ForEach(since.removedCommits, id: \.sha) { commitRow($0, removed: true) }
            }
            if since.commitsTruncated {
                Text("Only the newest 250 commits are listed.").font(.caption).foregroundStyle(.secondary)
            }
            if since.rebaseMatchSkipped {
                Text("Too many commits to match rebased ones to those you reviewed, so every rewritten commit counts as new.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func commitRow(_ c: ReviewCommit, removed: Bool) -> some View {
        let row = HStack(spacing: 8) {
            Text(reportSha(c.sha)).font(.caption.monospaced()).foregroundStyle(.secondary)
            Text(c.subject).strikethrough(removed).lineLimit(1)
            if let from = c.rebasedFrom { Chip(text: "rebased", help: "Same change as \(from)") }
            Spacer()
            Text(c.author).foregroundStyle(.secondary)
            Text(reviewRelativeTime(c.date)).foregroundStyle(.secondary)
        }
        .font(.caption)
        .contentShape(Rectangle())
        return Group {
            if removed {
                row
            } else {
                Button { context.openTab(.commit(prId: pr.prId, sha: c.sha, subject: c.subject)) } label: { row }
                    .buttonStyle(.plain)
            }
        }
    }
}
