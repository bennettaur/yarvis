import Foundation
import Observation
import YarvisClient

/// A question being written about lines of a file.
struct ReviewAsk: Equatable {
    var path: String
    var startLine: Int
    var endLine: Int
    /// The lines as shown, sent with the question.
    var selection: String
}

/// One PR's writes from its code tabs that the provider hasn't echoed yet,
/// and what each file has open: the comment composer, the question being
/// asked, the last notice. Kept per PR rather than per tab, so a thread
/// looks the same in every tab and switching tabs keeps a half-written
/// comment.
@MainActor @Observable
final class ReviewAnnotationStore {
    private static var stores: [ObjectIdentifier: (pr: WeakPr, store: ReviewAnnotationStore)] = [:]

    struct WeakPr {
        weak var value: ReviewPrModel?
    }

    static func of(_ pr: ReviewPrModel) -> ReviewAnnotationStore {
        stores = stores.filter { $0.value.pr.value != nil }
        let key = ObjectIdentifier(pr)
        if let hit = stores[key] { return hit.store }
        let store = ReviewAnnotationStore()
        stores[key] = (WeakPr(value: pr), store)
        return store
    }

    private var nextId = 0

    // MARK: Threads

    private(set) var replies: [PostedReply] = []
    /// The resolved state this session last set, per thread id.
    private(set) var resolvedOverrides: [String: Bool] = [:]

    /// `thread` with this session's resolve applied, and its replies the
    /// provider hasn't returned yet.
    func shown(_ thread: PrThread) -> (thread: PrThread, pending: [PostedReply]) {
        var out = thread
        if let override = resolvedOverrides[thread.id], override != thread.isResolved { out.isResolved = override }
        let byId = [thread.id: thread]
        return (out, replies.filter { $0.threadId == thread.id && replyIsPending($0, threads: byId) })
    }

    /// Forgets writes the server now agrees with, so a later change made
    /// elsewhere (someone reopening the thread) isn't masked by them.
    func settle(_ threads: [PrThread]) {
        let byId = Dictionary(threads.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        // A thread missing from `threads` counts as not caught up, so a
        // partial list leaves the others' writes alone.
        let keptReplies = replies.filter { replyIsPending($0, threads: byId) }
        if keptReplies.count != replies.count { replies = keptReplies }
        let kept = pendingOverrides(resolvedOverrides, threads: byId)
        if kept != resolvedOverrides { resolvedOverrides = kept }
    }

    func reply(_ context: ReviewTabContext, to thread: PrThread, body: String) async throws {
        try await context.client.replyToPrThread(context.pr.ref, thread, body: body)
        replies.append(PostedReply(id: nextId, threadId: thread.id, body: body, afterCount: thread.comments.count))
        nextId += 1
        context.pr.loadDetail(force: true)
    }

    func setResolved(_ context: ReviewTabContext, _ thread: PrThread, _ resolved: Bool) async throws {
        try await context.client.setPrThreadResolved(context.pr.ref, threadId: thread.id, resolved: resolved)
        resolvedOverrides[thread.id] = resolved
        context.pr.loadDetail(force: true)
    }

    // MARK: Line comments

    private(set) var composers: [String: CommentTarget] = [:]
    private(set) var posted: [String: [PostedLineComment]] = [:]
    /// The lines of the last comment GitHub put on the whole file instead,
    /// because they aren't part of the diff.
    private(set) var movedToFile: [String: CommentTarget] = [:]

    /// Opens the composer on a line, or with `extend` grows an open one on
    /// the same side to reach it.
    func openComposer(path: String, side: DiffSide, line: Int, extend: Bool = false) {
        movedToFile[path] = nil
        if extend, let current = composers[path], current.side == side {
            composers[path] = extendTarget(current, to: line)
        } else {
            composers[path] = CommentTarget(side: side, line: line)
        }
    }

    func closeComposer(path: String) { composers[path] = nil }

    func dismissMoved(path: String) { movedToFile[path] = nil }

    /// This session's comments on `path` that no thread carries yet.
    func pendingComments(path: String, threads: [PrThread]) -> [PostedLineComment] {
        pendingLineComments(posted[path] ?? [], threads: threads)
    }

    func settleComments(path: String, threads: [PrThread]) {
        guard let list = posted[path] else { return }
        let pending = pendingLineComments(list, threads: threads)
        if pending.count != list.count { posted[path] = pending }
    }

    func submitComment(_ context: ReviewTabContext, path: String, target: CommentTarget, body: String) async throws {
        let comment = NewPrComment(path: path, line: target.line, body: body, side: target.side,
                                   startLine: target.startLine)
        let result = try await context.client.postPrComment(context.pr.ref, comment, seen: context.pr.pr.seen)
        context.pr.invalidateLastReview()
        if result.placement == .file {
            movedToFile[path] = target
        } else {
            posted[path, default: []].append(PostedLineComment(id: nextId, target: target, body: body))
            nextId += 1
        }
        composers[path] = nil
        context.pr.loadDetail(force: true)
    }

    // MARK: Questions

    private(set) var asking: ReviewAsk?
    private(set) var askPending = false
    var insightError: String?

    func openAsk(_ ask: ReviewAsk) {
        insightError = nil
        asking = ask
    }

    func closeAsk() { asking = nil }

    func submitAsk(_ context: ReviewTabContext, question: String) async {
        let trimmed = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let target = asking, !trimmed.isEmpty else { return }
        askPending = true
        insightError = nil
        defer { askPending = false }
        do {
            let created = try await context.client.askAboutLines(context.pr.ref, AskAboutLines(
                path: target.path, startLine: target.startLine, endLine: target.endLine,
                selection: target.selection, question: trimmed))
            context.pr.setInsights([created] + (context.pr.insights.value ?? []))
            if asking == target { asking = nil }
        } catch {
            insightError = error.localizedDescription
        }
    }

    func postInsight(_ context: ReviewTabContext, id: String) async {
        do {
            let posted = try await context.client.postInsight(id: id)
            context.pr.setInsights((context.pr.insights.value ?? []).map { $0.id == id ? posted : $0 })
            context.pr.loadDetail(force: true)
        } catch {
            insightError = error.localizedDescription
        }
    }

    func deleteInsight(_ context: ReviewTabContext, id: String) async {
        context.pr.setInsights((context.pr.insights.value ?? []).filter { $0.id != id })
        do {
            try await context.client.deleteInsight(id: id)
        } catch {
            insightError = error.localizedDescription
        }
    }

    // MARK: Notices

    /// Why the last line action in a file did nothing.
    private(set) var notices: [String: String] = [:]

    func setNotice(_ text: String?, path: String) { notices[path] = text }
}
