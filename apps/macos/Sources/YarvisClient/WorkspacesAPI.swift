import Foundation

extension YarvisClient {
    private static func workspacePath(_ id: String, _ rest: String = "") -> String {
        sidecar("/api/workspaces/\(encodePathSegment(id))\(rest)")
    }

    private static func repoPath(_ id: String, _ workspaceRepoId: String, _ rest: String) -> String {
        workspacePath(id, "/repos/\(encodePathSegment(workspaceRepoId))\(rest)")
    }

    /// `?worktree=` for a non-primary worktree; nothing for the primary one.
    private static func worktreeQuery(_ worktree: String?, joiner: String = "?") -> String {
        worktree.map { "\(joiner)worktree=\(encodeQueryValue($0))" } ?? ""
    }

    // MARK: Workspaces

    /// The list. `badges` tells the sidecar the user is looking at it, so it
    /// polls PR badges sooner; send it only while the window is in front.
    public func workspaceList(badges: Bool) async throws -> [WorkspaceSummary] {
        try await get([WorkspaceSummary].self, Self.sidecar("/api/workspaces\(badges ? "?badges=1" : "")"))
    }

    /// One workspace. `viewing` keeps its PRs fresh on the sidecar; send it
    /// only while the window is in front.
    public func workspace(id: String, viewing: Bool) async throws -> WorkspaceDetail {
        try await get(WorkspaceDetail.self, Self.workspacePath(id, viewing ? "?viewing=1" : ""))
    }

    public func createWorkspace(_ new: NewWorkspace) async throws -> WorkspaceSummary {
        var body: [String: JSONValue] = [
            "name": .string(new.name),
            "repoIds": .array(new.repoIds.map(JSONValue.string)),
        ]
        let branches = new.existingBranches.filter { !$0.value.isEmpty }
        if !branches.isEmpty { body["existingBranches"] = .object(branches.mapValues(JSONValue.string)) }
        if let taskId = new.taskId, !taskId.isEmpty { body["taskId"] = .string(taskId) }
        if let startWork = new.startWork { body["startWork"] = .bool(startWork) }
        return try await post(WorkspaceSummary.self, Self.sidecar("/api/workspaces"), body: .object(body))
    }

    public func renameWorkspace(id: String, name: String) async throws {
        try await send("PATCH", Self.workspacePath(id), body: .object(["name": .string(name)]))
    }

    /// Starts provisioning, or follows the run already going. Ending the
    /// stream doesn't stop the run.
    public func provisionStream(id: String) throws -> AsyncThrowingStream<ProvisionEvent, Error> {
        decodedEventStream(try request("POST", Self.workspacePath(id, "/provision")), ProvisionEvent.decode)
    }

    /// Marks a failed workspace usable as it is. 409 while a provision still runs.
    public func ignoreWorkspaceError(id: String) async throws {
        try await send("POST", Self.workspacePath(id, "/ignore-error"))
    }

    /// Starts the archive in the background (202); poll the workspace to follow it.
    public func archiveWorkspace(id: String, _ r: ArchiveRequest) async throws {
        try await send("POST", Self.workspacePath(id, "/archive"), body: .object([
            "summary": r.summary.map(JSONValue.string) ?? .null,
            "mergedPrUrl": r.mergedPrUrl.map(JSONValue.string) ?? .null,
            "force": .bool(r.force),
            "closeIssueIds": .array(r.closeIssueIds.map(JSONValue.string)),
        ]))
    }

    /// Tells the sidecar the user ended the agent, so a restart doesn't resume it.
    public func stopWorkspaceAgent(id: String) async throws {
        try await send("POST", Self.workspacePath(id, "/agent/stop"))
    }

    public func unlinkWorkspaceTask(id: String, taskId: String) async throws {
        try await send("DELETE", Self.workspacePath(id, "/tasks/\(encodePathSegment(taskId))"))
    }

    public func unlinkWorkspaceIssue(id: String, _ issue: IssueLink) async throws {
        let query = "provider=\(encodeQueryValue(issue.provider))&sourceKey=\(encodeQueryValue(issue.sourceKey))"
            + "&externalId=\(encodeQueryValue(issue.externalId))"
        try await send("DELETE", Self.workspacePath(id, "/issues?\(query)"))
    }

    // MARK: Agent session

    /// Starts `ws-claude:<id>` in the workspace's folder. `harness` names a
    /// configured harness; nil uses the default.
    public func startAgentSession(workspace: WorkspaceSummary, harness: String?) async throws {
        var args: [String: JSONValue] = [
            "workspaceId": .string(workspace.id),
            "cwd": .string(workspace.rootPath),
            "name": .string(workspace.name),
            "remoteControl": .bool(false),
        ]
        if let harness { args["harness"] = .string(harness) }
        _ = try await core("pty_start_claude", args)
    }

    public func agentConfig() async throws -> AgentConfig {
        try Self.decode(AgentConfig.self, await core("get_agent_config"))
    }

    /// The harness a live session was started with, or nil.
    public func ptySessionHarness(_ id: String) async throws -> AgentHarness? {
        try Self.decode(AgentHarness?.self, await core("pty_session_harness", ["id": .string(id)]))
    }

    // MARK: Worktrees and files

    public func workspaceWorktrees(id: String) async throws -> [WorktreeListing] {
        try await get([WorktreeListing].self, Self.workspacePath(id, "/worktrees"))
    }

    public func workspaceFiles(id: String, repo workspaceRepoId: String, worktree: String? = nil) async throws -> [String] {
        try await get([String].self, Self.repoPath(id, workspaceRepoId, "/files\(Self.worktreeQuery(worktree))"))
    }

    public func workspaceChanges(id: String, repo workspaceRepoId: String, worktree: String? = nil) async throws -> [ChangedFile] {
        try await get([ChangedFile].self, Self.repoPath(id, workspaceRepoId, "/changes\(Self.worktreeQuery(worktree))"))
    }

    public func workspaceDiff(id: String, repo workspaceRepoId: String, path: String, worktree: String? = nil) async throws -> FileDiff {
        try await get(FileDiff.self, Self.repoPath(
            id, workspaceRepoId, "/diff?path=\(encodeQueryValue(path))\(Self.worktreeQuery(worktree, joiner: "&"))"))
    }

    public func readWorkspaceFile(id: String, repo workspaceRepoId: String, path: String,
                                  worktree: String? = nil) async throws -> WorkspaceFile {
        try await get(WorkspaceFile.self, Self.repoPath(
            id, workspaceRepoId, "/file?path=\(encodeQueryValue(path))\(Self.worktreeQuery(worktree, joiner: "&"))"))
    }

    /// Saves a file if it still has `expectedHash` on disk. Returns the new
    /// hash, or nil when the file changed since it was read (409).
    public func saveWorkspaceFile(id: String, repo workspaceRepoId: String, path: String, content: String,
                                  expectedHash: String, worktree: String? = nil) async throws -> String? {
        struct Saved: Decodable { var hash: String }
        var body: [String: JSONValue] = [
            "path": .string(path), "content": .string(content), "expectedHash": .string(expectedHash),
        ]
        if let worktree { body["worktree"] = .string(worktree) }
        do {
            return try Self.decode(Saved.self, await send("PUT", Self.repoPath(id, workspaceRepoId, "/file"), body: .object(body))).hash
        } catch YarvisError.http(status: 409, _, _) {
            return nil
        }
    }

    /// Runs a git fetch on the server, so it is slow; poll it gently.
    public func workspaceSync(id: String, repo workspaceRepoId: String) async throws -> SyncStatus {
        try await get(SyncStatus.self, Self.repoPath(id, workspaceRepoId, "/sync"))
    }

    // MARK: PRs

    public func detectWorkspacePrs(id: String) async throws -> DetectedPrs {
        try await post(DetectedPrs.self, Self.workspacePath(id, "/prs/detect"))
    }

    public func linkWorkspacePr(id: String, repo workspaceRepoId: String, number: Int) async throws {
        try await send("POST", Self.repoPath(id, workspaceRepoId, "/prs"), body: .object(["number": .number(Double(number))]))
    }

    public func unlinkWorkspacePr(id: String, repo workspaceRepoId: String, number: Int) async throws {
        try await send("DELETE", Self.repoPath(id, workspaceRepoId, "/prs/\(number)"))
    }

    // MARK: Review comments

    public func reviewComments(workspaceId: String) async throws -> [ReviewComment] {
        try await get([ReviewComment].self, Self.workspacePath(workspaceId, "/review-comments"))
    }

    public func createReviewComment(workspaceId: String, repo workspaceRepoId: String, path: String, startLine: Int,
                                    endLine: Int, body: String) async throws -> ReviewComment {
        try await post(ReviewComment.self, Self.workspacePath(workspaceId, "/review-comments"), body: .object([
            "workspaceRepoId": .string(workspaceRepoId),
            "path": .string(path),
            "startLine": .number(Double(startLine)),
            "endLine": .number(Double(endLine)),
            "body": .string(body),
        ]))
    }

    public func setReviewCommentResolved(workspaceId: String, commentId: String,
                                         resolved: Bool) async throws -> ReviewComment {
        try Self.decode(ReviewComment.self, await send(
            "PATCH", Self.workspacePath(workspaceId, "/review-comments/\(encodePathSegment(commentId))"),
            body: .object(["resolved": .bool(resolved)])))
    }

    public func deleteReviewComment(workspaceId: String, commentId: String) async throws {
        try await send("DELETE", Self.workspacePath(workspaceId, "/review-comments/\(encodePathSegment(commentId))"))
    }

    // MARK: Repos and tasks

    public func repos() async throws -> [Repo] {
        try await get([Repo].self, Self.sidecar("/api/repos"))
    }

    /// A repo's remote branches, for picking one to work on.
    public func repoBranches(repoId: String) async throws -> [String] {
        try await get([String].self, Self.sidecar("/api/repos/\(encodePathSegment(repoId))/branches"))
    }

    public func openTasks() async throws -> [WorkspaceTask] {
        try await get([WorkspaceTask].self, Self.sidecar("/api/tasks?status=open"))
    }
}
