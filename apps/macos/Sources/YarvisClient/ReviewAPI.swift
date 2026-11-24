import Foundation

extension YarvisClient {
    private static func reviewPath(_ rest: String = "") -> String {
        sidecar("/api/review-workspaces\(rest)")
    }

    private static func reviewPrPath(_ workspaceId: String, _ prId: String, _ rest: String = "") -> String {
        reviewPath("/\(encodePathSegment(workspaceId))/prs/\(encodePathSegment(prId))\(rest)")
    }

    /// The sidecar route for one PR on its provider. Azure's org comes from
    /// the sidecar's config, so it isn't in the path.
    static func prPath(_ ref: PrRef, _ rest: String = "") -> String {
        switch ref {
        case .github(let owner, let repo, let n):
            return sidecar("/api/github/pr/\(encodePathSegment(owner))/\(encodePathSegment(repo))/\(n)\(rest)")
        case .azure(_, let project, let repo, let id):
            return sidecar("/api/azure/pr/\(encodePathSegment(project))/\(encodePathSegment(repo))/\(id)\(rest)")
        }
    }

    private static func query(_ items: [(String, String)]) -> String {
        items.isEmpty ? "" : "?" + items.map { "\($0.0)=\(encodeQueryValue($0.1))" }.joined(separator: "&")
    }

    // MARK: Review workspaces

    public func reviewWorkspaces(archived: Bool = false) async throws -> [ReviewWorkspace] {
        try await get([ReviewWorkspace].self, Self.reviewPath(archived ? "?archived=true" : ""))
    }

    public func reviewWorkspace(id: String) async throws -> ReviewWorkspace {
        try await get(ReviewWorkspace.self, Self.reviewPath("/\(encodePathSegment(id))"))
    }

    public func createReviewWorkspace(name: String, refs: [PrRef] = []) async throws -> ReviewWorkspace {
        var body: [String: JSONValue] = ["name": .string(name)]
        if !refs.isEmpty { body["refs"] = .array(refs.map(\.json)) }
        return try await post(ReviewWorkspace.self, Self.reviewPath(), body: .object(body))
    }

    public func renameReviewWorkspace(id: String, name: String) async throws -> ReviewWorkspace {
        try Self.decode(ReviewWorkspace.self, await send(
            "PATCH", Self.reviewPath("/\(encodePathSegment(id))"), body: .object(["name": .string(name)])))
    }

    /// Records the open, which orders the list.
    @discardableResult
    public func openReviewWorkspace(id: String) async throws -> ReviewWorkspace {
        try await post(ReviewWorkspace.self, Self.reviewPath("/\(encodePathSegment(id))/open"))
    }

    /// Answers with the workspace `archiving`; it reads `archived` once the checkouts are gone.
    @discardableResult
    public func archiveReviewWorkspace(id: String) async throws -> ReviewWorkspace {
        try await post(ReviewWorkspace.self, Self.reviewPath("/\(encodePathSegment(id))/archive"))
    }

    /// Adds a PR and starts cloning it; follow `reviewPrProgress`.
    public func addReviewPr(workspaceId: String, ref: PrRef) async throws -> ReviewWorkspacePr {
        try await post(ReviewWorkspacePr.self, Self.reviewPath("/\(encodePathSegment(workspaceId))/prs"),
                       body: .object(["ref": ref.json]))
    }

    public func removeReviewPr(workspaceId: String, prId: String) async throws {
        try await send("DELETE", Self.reviewPrPath(workspaceId, prId))
    }

    /// Fetches the PR's latest head and moves its checkout there, in the background.
    public func refreshReviewPr(workspaceId: String, prId: String) async throws -> ReviewWorkspacePr {
        try await post(ReviewWorkspacePr.self, Self.reviewPrPath(workspaceId, prId, "/refresh"))
    }

    /// The PTY id the server gives a workspace's Ask Claude session
    /// (`review_session_id` in the server's `pty.rs`).
    public static func reviewClaudeSessionId(workspaceId: String) -> String { "review-claude:\(workspaceId)" }

    /// Starts Claude Code over the workspace's checked-out PRs, or leaves the
    /// one running. `loadRepoConfig` saves that choice for the workspace; nil
    /// keeps the saved one. Answers with the choice the session started with.
    public func startReviewClaudeSession(workspaceId: String, loadRepoConfig: Bool? = nil) async throws -> Bool {
        struct Started: Decodable { var loadRepoConfig: Bool }
        var body: [String: JSONValue] = [:]
        if let loadRepoConfig { body["loadRepoConfig"] = .bool(loadRepoConfig) }
        return try await post(Started.self, Self.reviewPath("/\(encodePathSegment(workspaceId))/claude-session"),
                              body: .object(body)).loadRepoConfig
    }

    /// Replays the PR's latest clone, refresh or setup run and follows the
    /// rest of it. Ends at once when there is no recent run.
    public func reviewPrProgress(workspaceId: String, prId: String) throws
        -> AsyncThrowingStream<ReviewProgressEvent, Error> {
        decodedEventStream(try request("GET", Self.reviewPrPath(workspaceId, prId, "/progress")),
                           ReviewProgressEvent.decode)
    }

    // MARK: Reading the checkout

    public func reviewChangedFiles(workspaceId: String, prId: String) async throws -> ReviewChangedFiles {
        try await get(ReviewChangedFiles.self, Self.reviewPrPath(workspaceId, prId, "/changed-files"))
    }

    public func reviewTree(workspaceId: String, prId: String) async throws -> ReviewTree {
        try await get(ReviewTree.self, Self.reviewPrPath(workspaceId, prId, "/tree"))
    }

    /// A file at the PR's head, or at the merge-base for `.base`.
    public func reviewFile(workspaceId: String, prId: String, path: String,
                           side: ReviewFileSide) async throws -> ReviewFileContent {
        try await get(ReviewFileContent.self, Self.reviewPrPath(
            workspaceId, prId, "/file" + Self.query([("path", path), ("side", side.rawValue)])))
    }

    /// The patch for one changed file; a rename's old path comes with it.
    public func reviewFileDiff(workspaceId: String, prId: String, path: String) async throws -> ReviewFileDiff {
        try await get(ReviewFileDiff.self, Self.reviewPrPath(workspaceId, prId, "/diff" + Self.query([("path", path)])))
    }

    /// Where `symbol` is declared or used at the PR's head, by text search.
    /// 409 until the checkout is ready.
    public func reviewSymbolSearch(workspaceId: String, prId: String, kind: ReviewSymbolKind, path: String,
                                   symbol: String, line: Int? = nil) async throws -> ReviewSymbolSearch {
        var items = [("path", path), ("symbol", symbol)]
        if let line { items.append(("line", String(line))) }
        return try await get(ReviewSymbolSearch.self,
                             Self.reviewPrPath(workspaceId, prId, "/\(kind.rawValue)" + Self.query(items)))
    }

    // MARK: Setup consent

    public func reviewSetupInfo(workspaceId: String, prId: String) async throws -> ReviewSetupInfo {
        try await get(ReviewSetupInfo.self, Self.reviewPrPath(workspaceId, prId, "/setup"))
    }

    /// Answers the setup prompt with the script and head it showed; 409 when
    /// either moved since. Output streams on `reviewPrProgress`.
    public func answerReviewSetup(workspaceId: String, prId: String, grant: Bool, script: String?,
                                  headSha: String?) async throws -> ReviewWorkspacePr {
        try await post(ReviewWorkspacePr.self, Self.reviewPrPath(workspaceId, prId, "/setup"), body: .object([
            "grant": .bool(grant),
            "script": script.map(JSONValue.string) ?? .null,
            "headSha": headSha.map(JSONValue.string) ?? .null,
        ]))
    }

    // MARK: Since last review and commits

    public func lastReview(workspaceId: String, prId: String) async throws -> LastReview {
        try await get(LastReview.self, Self.reviewPrPath(workspaceId, prId, "/last-review"))
    }

    /// "Mark reviewed here": moves the starting point to the checkout's head.
    public func markReviewedHere(workspaceId: String, prId: String) async throws -> ReviewMark {
        try await post(ReviewMark.self, Self.reviewPrPath(workspaceId, prId, "/review-mark"))
    }

    public func sinceReview(workspaceId: String, prId: String, from: String) async throws -> SinceReview {
        try await get(SinceReview.self, Self.reviewPrPath(workspaceId, prId, "/since-review" + Self.query([("from", from)])))
    }

    public func sinceReviewFile(workspaceId: String, prId: String, path: String,
                                from: String) async throws -> SinceFileView {
        try await get(SinceFileView.self, Self.reviewPrPath(
            workspaceId, prId, "/since-review/file" + Self.query([("path", path), ("from", from)])))
    }

    /// The PR's commits; `from` marks those after it as new.
    public func reviewCommits(workspaceId: String, prId: String, from: String? = nil) async throws -> PrCommits {
        try await get(PrCommits.self, Self.reviewPrPath(
            workspaceId, prId, "/commits" + Self.query(from.map { [("from", $0)] } ?? [])))
    }

    public func commitFiles(workspaceId: String, prId: String, sha: String) async throws -> CommitFiles {
        try await get(CommitFiles.self, Self.reviewPrPath(workspaceId, prId, "/commits/\(encodePathSegment(sha))/diff"))
    }

    public func commitFileDiff(workspaceId: String, prId: String, sha: String,
                               path: String) async throws -> CommitFileDiff {
        try await get(CommitFileDiff.self, Self.reviewPrPath(
            workspaceId, prId, "/commits/\(encodePathSegment(sha))/diff" + Self.query([("path", path)])))
    }

    // MARK: Re-review summary

    public func latestRereview(workspaceId: String, prId: String, from: String? = nil) async throws -> LatestRereview {
        try await get(LatestRereview.self, Self.reviewPrPath(
            workspaceId, prId, "/rereview" + Self.query(from.map { [("from", $0)] } ?? [])))
    }

    public func startRereview(workspaceId: String, prId: String, from: String? = nil) async throws -> StartedRereview {
        try await post(StartedRereview.self, Self.reviewPrPath(
            workspaceId, prId, "/rereview" + Self.query(from.map { [("from", $0)] } ?? [])))
    }

    public func rereviewRunConfig() async throws -> RereviewRunConfig {
        try await get(RereviewRunConfig.self, Self.sidecar("/api/pr-models/rereview"))
    }

    // MARK: Agent runs

    /// Replays what the run has done so far, then follows it to its `done`.
    public func agentRunEvents(id: String) throws -> AsyncThrowingStream<AgentRunEvent, Error> {
        decodedEventStream(try request("GET", Self.sidecar("/api/agent-runs/\(encodePathSegment(id))/events")),
                           AgentRunEvent.decode)
    }

    public func cancelAgentRun(id: String) async throws {
        try await send("POST", Self.sidecar("/api/agent-runs/\(encodePathSegment(id))/cancel"))
    }

    // MARK: Verification

    /// The checklist, each section's latest run and the report they make.
    public func verificationChecklist(workspaceId: String, prId: String) async throws -> VerificationChecklist {
        try await get(VerificationChecklist.self, Self.reviewPrPath(workspaceId, prId, "/verification"))
    }

    /// Starts a run per section. Throws only when none started or joined;
    /// the rest come back in `failed`.
    public func startVerification(workspaceId: String, prId: String, sections: [String],
                                  namedTickets: [String] = [], choice: VerificationRunChoice = .init(),
                                  harness: String? = nil) async throws -> StartedVerification {
        var body: [String: JSONValue] = ["sections": .array(sections.map(JSONValue.string))]
        if !namedTickets.isEmpty { body["namedTickets"] = .array(namedTickets.map(JSONValue.string)) }
        var override: [String: JSONValue] = [:]
        if let model = choice.model { override["model"] = .string(model) }
        if let effort = choice.effort { override["effort"] = .string(effort) }
        if !override.isEmpty { body["override"] = .object(override) }
        if let harness, !harness.isEmpty { body["harness"] = .string(harness) }
        return try await post(StartedVerification.self, Self.reviewPrPath(workspaceId, prId, "/verification"),
                              body: .object(body))
    }

    public func verificationEvidence(workspaceId: String, prId: String) async throws -> VerificationEvidence {
        try await get(VerificationEvidence.self, Self.reviewPrPath(workspaceId, prId, "/evidence"))
    }

    public func verificationUpstack(workspaceId: String, prId: String) async throws -> VerificationUpstack {
        try await get(VerificationUpstack.self, Self.reviewPrPath(workspaceId, prId, "/upstack"))
    }

    public func verificationRunConfig() async throws -> VerificationRunConfig {
        try await get(VerificationRunConfig.self, Self.sidecar("/api/pr-models/verification"))
    }

    // MARK: Mutation testing

    public func mutationTesting(workspaceId: String, prId: String) async throws -> MutationTestingState {
        try await get(MutationTestingState.self, Self.reviewPrPath(workspaceId, prId, "/mutation-testing"))
    }

    /// `confirmRunTests` is the user agreeing to run the PR's tests without a setup script.
    public func startMutationTesting(workspaceId: String, prId: String, headSha: String,
                                     confirmRunTests: Bool = false) async throws -> StartedMutation {
        var body: [String: JSONValue] = ["headSha": .string(headSha)]
        if confirmRunTests { body["confirmRunTests"] = .bool(true) }
        return try await post(StartedMutation.self, Self.reviewPrPath(workspaceId, prId, "/mutation-testing"),
                              body: .object(body))
    }

    public func cancelMutationTesting(workspaceId: String, prId: String) async throws {
        try await send("POST", Self.reviewPrPath(workspaceId, prId, "/mutation-testing/cancel"))
    }

    /// Replays the pass from its start and follows it; ends at once when
    /// none is running on this sidecar.
    public func mutationProgress(workspaceId: String, prId: String) throws
        -> AsyncThrowingStream<MutationProgressEvent, Error> {
        decodedEventStream(try request("GET", Self.reviewPrPath(workspaceId, prId, "/mutation-testing/progress")),
                           MutationProgressEvent.decode)
    }

    public func mutationTestingConfig() async throws -> MutationTestingConfig {
        try await get(MutationTestingConfig.self, Self.sidecar("/api/mutation-testing-config"))
    }

    // MARK: The PR on its provider

    /// The summary for a PR the user named rather than picked from a list.
    public func prSummary(_ ref: PrRef) async throws -> PrSummary {
        switch ref {
        case .github:
            struct Raw: Decodable {
                var title, url, author, state, createdAt, updatedAt: String
                var draft: Bool
                var baseRef, headRef: String?
            }
            let r = try await get(Raw.self, Self.prPath(ref, "/summary"))
            return PrSummary(ref: ref, title: r.title, url: r.url, author: r.author, draft: r.draft, state: r.state,
                             createdAt: r.createdAt, updatedAt: r.updatedAt, baseRef: r.baseRef, headRef: r.headRef)
        case .azure(let org, _, _, _):
            struct Raw: Decodable {
                var title, url, author, status, createdAt: String
                var draft: Bool
            }
            let r = try await get(Raw.self, Self.prPath(ref, "/summary" + Self.query([("org", org)])))
            return PrSummary(ref: ref, title: r.title, url: r.url, author: r.author, draft: r.draft, state: r.status,
                             createdAt: r.createdAt, updatedAt: r.createdAt)
        }
    }

    /// The cheap read a poll uses to notice a push.
    public func prStatus(_ ref: PrRef) async throws -> PrStatus {
        try await get(PrStatus.self, Self.prPath(ref))
    }

    public func prDetail(_ ref: PrRef) async throws -> PrDetail {
        try await get(PrDetail.self, Self.prPath(ref, "/detail"))
    }

    /// Nil for Azure; a PR that isn't stacked is a one-entry stack.
    public func prStack(_ ref: PrRef) async throws -> PrStack? {
        struct Answer: Decodable { var stack: PrStack? }
        return try await get(Answer.self, Self.sidecar("/api/pr/stack" + Self.query(ref.queryItems))).stack
    }

    /// `seen` is what the page showed, recorded as where the user reviewed.
    public func postPrComment(_ ref: PrRef, _ comment: NewPrComment, seen: SeenCommits) async throws -> PostedComment {
        var body = seen.fields
        body["path"] = .string(comment.path)
        body["line"] = .number(Double(comment.line))
        body["body"] = .string(comment.body)
        if comment.side == .left { body["side"] = .string(DiffSide.left.rawValue) }
        if let start = comment.startLine { body["startLine"] = .number(Double(start)) }
        return try await post(PostedComment.self, Self.prPath(ref, "/comments"), body: .object(body))
    }

    /// Azure threads a reply under the thread's first comment when its id is
    /// a number, and leaves the parent to the sidecar otherwise.
    public func replyToPrThread(_ ref: PrRef, _ thread: PrThread, body: String) async throws {
        var payload: [String: JSONValue] = ["body": .string(body)]
        if case .azure = ref, let first = thread.comments.first?.id, let parent = Int(first) {
            payload["parentCommentId"] = .number(Double(parent))
        }
        try await send("POST", Self.prPath(ref, "/threads/\(encodePathSegment(thread.id))/replies"),
                       body: .object(payload))
    }

    public func setPrThreadResolved(_ ref: PrRef, threadId: String, resolved: Bool) async throws {
        try await send("POST", Self.prPath(ref, "/threads/\(encodePathSegment(threadId))/\(resolved ? "resolve" : "unresolve")"))
    }

    /// A review verdict in the provider's own terms: GitHub reviews, Azure
    /// votes (10 approves, -10 rejects). `body` is required for
    /// `.requestChanges`; the sidecar refuses one without it.
    public func applyReviewAction(_ ref: PrRef, _ action: PrReviewAction, body: String? = nil,
                                  seen: SeenCommits = .init()) async throws {
        if action == .publish {
            try await send("POST", Self.prPath(ref, "/ready"))
            return
        }
        var payload = seen.fields
        if let body { payload["body"] = .string(body) }
        switch ref {
        case .github:
            payload["event"] = .string(action == .approve ? "APPROVE" : "REQUEST_CHANGES")
            try await send("POST", Self.prPath(ref, "/reviews"), body: .object(payload))
        case .azure:
            payload["vote"] = .number(action == .approve ? 10 : -10)
            try await send("POST", Self.prPath(ref, "/vote"), body: .object(payload))
        }
    }

    /// GitHub only: Azure's detail lists no merge methods, so the UI never offers it.
    /// `headSha` is the commit the user reviewed; GitHub refuses the merge once
    /// the branch has moved past it.
    public func mergePr(_ ref: PrRef, method: MergeMethod, headSha: String?) async throws {
        try await send("POST", Self.prPath(ref, "/merge"), body: Self.mergeBody(method, headSha))
    }

    public func enableAutoMerge(_ ref: PrRef, method: MergeMethod, headSha: String?) async throws {
        try await send("POST", Self.prPath(ref, "/auto-merge"), body: Self.mergeBody(method, headSha))
    }

    private static func mergeBody(_ method: MergeMethod, _ headSha: String?) -> JSONValue {
        var body = SeenCommits(headSha: headSha).fields
        body["method"] = .string(method.rawValue)
        return .object(body)
    }

    public func disableAutoMerge(_ ref: PrRef) async throws {
        try await send("DELETE", Self.prPath(ref, "/auto-merge"))
    }

    /// The paths the user marked viewed on GitHub. Azure has no such store;
    /// the app keeps that set itself.
    public func viewedFiles(_ ref: PrRef) async throws -> [String] {
        try await get([String].self, Self.prPath(ref, "/viewed"))
    }

    public func setFileViewed(_ ref: PrRef, path: String, viewed: Bool) async throws {
        try await send("POST", Self.prPath(ref, "/viewed"),
                       body: .object(["path": .string(path), "viewed": .bool(viewed)]))
    }

    /// Hands the PR's conflicts to a workspace agent. A `needs_confirm`
    /// answer asks again with `confirm` true.
    public func resolvePrConflicts(_ ref: PrRef, confirm: Bool) async throws -> AgentHandOff {
        try await post(AgentHandOff.self, Self.sidecar("/api/pr/resolve-conflicts"),
                       body: .object(["ref": ref.json, "confirm": .bool(confirm)]))
    }

    /// Creates a workspace on the PR's branch, or finds the one already there.
    public func startWorkspaceForPr(_ ref: PrRef) async throws -> PrWorkspaceStart {
        try await post(PrWorkspaceStart.self, Self.sidecar("/api/pr/workspace"), body: .object(["ref": ref.json]))
    }

    /// The workspace on this PR's branch, if any.
    public func workspaceForPr(_ ref: PrRef) async throws -> WorkspaceForPr? {
        let items: [(String, String)]
        switch ref {
        case .github(let owner, let repo, let n):
            items = [("provider", "github"), ("owner", owner), ("repo", repo), ("number", String(n))]
        case .azure(let org, let project, let repo, let id):
            items = [("provider", "azure"), ("org", org), ("project", project), ("repo", repo), ("number", String(id))]
        }
        return try await get(WorkspaceForPr?.self, Self.sidecar("/api/workspaces/for-pr" + Self.query(items)))
    }

    /// Adds a verification finding to a Yarvis workspace's own review comments.
    public func addFindingToWorkspace(workspaceId: String, workspaceRepoId: String, path: String, line: Int,
                                      body: String) async throws -> ReviewComment {
        try await post(ReviewComment.self, Self.sidecar("/api/workspaces/\(encodePathSegment(workspaceId))/review-comments"),
                       body: .object([
                           "workspaceRepoId": .string(workspaceRepoId),
                           "path": .string(path),
                           "startLine": .number(Double(line)),
                           "endLine": .number(Double(line)),
                           "body": .string(body),
                           "source": .string("verification"),
                       ]))
    }

    // MARK: Guided review

    public func prGuide(_ ref: PrRef) async throws -> PrGuide? {
        struct Answer: Decodable { var guide: PrGuide? }
        return try await get(Answer.self, Self.sidecar("/api/pr/guide" + Self.query(ref.queryItems))).guide
    }

    /// A slow agent run (about a minute) that replaces any existing guide.
    public func generatePrGuide(_ ref: PrRef, title: String?) async throws -> PrGuide {
        try await post(PrGuide.self, Self.sidecar("/api/pr/guide"), body: .object([
            "ref": ref.json, "title": title.map(JSONValue.string) ?? .null,
        ]))
    }

    @discardableResult
    public func setPrGuideProgress(_ ref: PrRef, step: Int) async throws -> Int {
        struct Answer: Decodable { var currentStep: Int }
        return try Self.decode(Answer.self, await send(
            "PATCH", Self.sidecar("/api/pr/guide/progress"),
            body: .object(["ref": ref.json, "step": .number(Double(step))]))).currentStep
    }

    public func deletePrGuide(_ ref: PrRef) async throws {
        try await send("DELETE", Self.sidecar("/api/pr/guide" + Self.query(ref.queryItems)))
    }

    // MARK: Asking about lines

    public func prInsights(_ ref: PrRef) async throws -> [PrInsight] {
        struct Answer: Decodable { var insights: [PrInsight] }
        return try await get(Answer.self, Self.sidecar("/api/pr/insights" + Self.query(ref.queryItems))).insights
    }

    /// A slow agent run; answers with the new insight.
    public func askAboutLines(_ ref: PrRef, _ ask: AskAboutLines) async throws -> PrInsight {
        try await post(PrInsight.self, Self.sidecar("/api/pr/insight"), body: .object([
            "ref": ref.json,
            "path": .string(ask.path),
            "startLine": .number(Double(ask.startLine)),
            "endLine": .number(Double(ask.endLine)),
            "selection": .string(ask.selection),
            "question": .string(ask.question),
        ]))
    }

    /// Posts the answer on the PR; `placement` says where it landed.
    public func postInsight(id: String) async throws -> PrInsight {
        try await post(PrInsight.self, Self.sidecar("/api/pr/insight/\(encodePathSegment(id))/post"))
    }

    public func deleteInsight(id: String) async throws {
        try await send("DELETE", Self.sidecar("/api/pr/insight/\(encodePathSegment(id))"))
    }
}
