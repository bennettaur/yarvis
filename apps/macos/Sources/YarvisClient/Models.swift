import Foundation

// The server's JSON shapes. Field names match the Rust structs in
// `server/crates/yarvis-server/src/` and the web client's types in `src/lib/`,
// which are the source of truth. Unknown keys are ignored, so the server can
// add fields without breaking an older app.

// MARK: - Server auth and devices

public enum Scope: String, Codable, Sendable, CaseIterable {
    case read, chat, terminal, approve, admin
}

/// The device a token belongs to (`DeviceContext` in `auth/mod.rs`).
public struct Device: Codable, Sendable, Equatable {
    public var deviceId: String
    public var name: String
    public var scopes: [Scope]
    /// Milliseconds since the epoch of the last passphrase or code check.
    public var verifiedAt: Int64?

    public init(deviceId: String, name: String, scopes: [Scope], verifiedAt: Int64? = nil) {
        self.deviceId = deviceId
        self.name = name
        self.scopes = scopes
        self.verifiedAt = verifiedAt
    }

    public func has(_ scope: Scope) -> Bool { scopes.contains(scope) }

    // A scope this build doesn't know is dropped rather than failing sign-in.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        deviceId = try c.decode(String.self, forKey: .deviceId)
        name = try c.decode(String.self, forKey: .name)
        scopes = try c.decode([String].self, forKey: .scopes).compactMap(Scope.init(rawValue:))
        verifiedAt = try c.decodeIfPresent(Int64.self, forKey: .verifiedAt)
    }
}

/// A sign-in's answer. The token is shown only this once.
public struct SignedIn: Codable, Sendable {
    public var token: String
    public var device: Device
}

/// `GET /api/auth/status`. Every field is optional so a server on another
/// auth version still answers.
public struct AuthStatus: Codable, Sendable {
    public var setupRequired: Bool?
    /// `absent`, `uninitialized`, `locked` or `unlocked`.
    public var vault: String?
}

/// The error body every server route returns.
public struct APIErrorBody: Decodable, Sendable {
    public var error: String
    public var detail: String?

    // The sidecar sometimes sends a zod error object as `error`.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .error) {
            error = s
        } else {
            error = (try? c.decode(JSONValue.self, forKey: .error))?.prettyPrinted ?? "error"
        }
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
    }

    enum CodingKeys: String, CodingKey { case error, detail }
}

// MARK: - Events and approvals

/// One entry in the server's event log, as `/api/events` sends it.
public struct ServerEvent: Codable, Sendable, Equatable {
    public var seq: Int64
    public var at: Int64
    public var deviceId: String?
    public var kind: String
    public var data: JSONValue
}

/// A server approval waiting on a device with `approve` (`GET /api/approvals`).
public struct Approval: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    /// What asked, such as `git.sign`.
    public var kind: String
    public var summary: String
    public var data: JSONValue
    public var createdAt: Int64
    /// After this the server counts it as denied.
    public var expiresAt: Int64
}

// MARK: - Chat (sidecar `chat/routes.ts`)

/// A chat thread. The sidecar calls these sessions.
public struct ChatSession: Codable, Sendable, Identifiable, Equatable, Hashable {
    public var id: String
    public var title: String?
    public var createdAt: String
    public var updatedAt: String
}

public struct ToolActivity: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var name: String
    public var server: String?
    public var args: JSONValue?
    /// `pending`, `ok`, `error` or `denied`.
    public var status: String
    public var result: String?
    public var durationMs: Double?

    public init(id: String, name: String, server: String? = nil, args: JSONValue? = nil,
                status: String, result: String? = nil, durationMs: Double? = nil) {
        self.id = id
        self.name = name
        self.server = server
        self.args = args
        self.status = status
        self.result = result
        self.durationMs = durationMs
    }
}

public struct ChatMessage: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var sessionId: String
    /// `user`, `assistant` or `tool`.
    public var role: String
    public var content: String
    /// Where the message came from, when not typed in a chat tab.
    public var metadata: ChatMessageMetadata?
    public var toolCalls: [ToolActivity]?
    public var createdAt: String

    public init(id: String, sessionId: String, role: String, content: String,
                metadata: ChatMessageMetadata? = nil, toolCalls: [ToolActivity]? = nil, createdAt: String) {
        self.id = id
        self.sessionId = sessionId
        self.role = role
        self.content = content
        self.metadata = metadata
        self.toolCalls = toolCalls
        self.createdAt = createdAt
    }
}

public struct ModelInfo: Codable, Sendable, Equatable, Hashable {
    public var id: String
    public var capabilities: [String]
    /// The context size at which the sidecar compacts this model's chats.
    public var compactAtTokens: Double?
}

public struct ProviderInfo: Codable, Sendable, Identifiable, Equatable, Hashable {
    public var id: String
    public var label: String
    public var models: [ModelInfo]
    /// False when the provider has no key set.
    public var available: Bool
    /// A provider the user added in Settings.
    public var custom: Bool?
}

/// A tool call waiting for the user inside a chat turn.
public struct ToolApprovalRequest: Codable, Sendable, Identifiable, Equatable {
    /// The tool call's id, which the answer route takes.
    public var id: String
    /// `mcp:<serverId>:<tool>` for an MCP tool, the bare name for a built-in.
    public var toolId: String?
    public var name: String
    /// The MCP server's name, empty for a built-in.
    public var server: String?
    public var args: JSONValue?
    /// The assistant's own stated reason for the call. Its claim, not the user's.
    public var reason: String?
}

/// One message on a chat turn's SSE stream.
public enum ChatStreamEvent: Sendable, Equatable {
    case delta(String)
    case reasoning(String)
    case toolCall(ToolActivity)
    case toolResult(id: String, status: String, result: String?, durationMs: Double?)
    case approvalRequest(ToolApprovalRequest)
    case attention(String)
    /// Ends the turn. Nothing of it was saved.
    case error(message: String, detail: String?)
    /// Ends the turn; the reply was saved.
    case done
    case ping
    /// A type this build doesn't know. Ignored.
    case unknown(String)

    public static func decode(_ json: Data) throws -> ChatStreamEvent {
        let v = try JSONDecoder().decode(JSONValue.self, from: json)
        guard let type = v["type"]?.stringValue else { return .unknown("") }
        func string(_ k: String) -> String? { v[k]?.stringValue }
        func number(_ k: String) -> Double? {
            if case .number(let n)? = v[k] { return n }
            return nil
        }
        switch type {
        case "delta": return .delta(string("text") ?? "")
        case "reasoning": return .reasoning(string("text") ?? "")
        case "tool_call":
            let id = string("id") ?? ""
            return .toolCall(ToolActivity(
                id: id, name: string("name") ?? id, server: string("server"),
                args: v["args"], status: "pending"))
        case "tool_result":
            return .toolResult(id: string("id") ?? "", status: string("status") ?? "ok",
                               result: string("result"), durationMs: number("durationMs"))
        case "tool_approval_request":
            return .approvalRequest(try JSONDecoder().decode(ToolApprovalRequest.self, from: json))
        case "attention": return .attention(string("reason") ?? "")
        case "error": return .error(message: string("message") ?? "the turn failed", detail: string("detail"))
        case "done": return .done
        case "ping": return .ping
        default: return .unknown(type)
        }
    }
}

// MARK: - Attention (sidecar `attention/`, `questions/`)

public struct AttentionItem: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var seq: Int64
    /// `claude-hook`, `chat-agent` or `system`.
    public var source: String
    public var sessionKey: String?
    public var workspaceId: String?
    /// `permission`, `idle`, `completed`, `error`, `info` or `question`.
    public var kind: String
    public var title: String
    public var body: String?
    /// `pending`, `read`, `resolved` or `dismissed`.
    public var status: String
    public var navTarget: JSONValue?
    public var payload: JSONValue?
    public var createdAt: String
    public var updatedAt: String

    /// A heads-down pass's question. It has its own kind and its own answer
    /// routes, on the web's Heads down page, so it isn't a `question` item.
    public var isHeadsDown: Bool {
        source == "system" && kind != "question" && (sessionKey?.hasPrefix("heads-down:") ?? false)
    }

    /// A permission prompt a Claude Code hook is holding open.
    public var isHookPermission: Bool {
        kind == "permission" && source == "claude-hook" && sessionKey != nil
    }
}

/// What the attention stream sends: a full row on every change.
public enum AttentionStreamEvent: Sendable, Equatable {
    case item(AttentionItem)
    case ping
    case unknown

    public static func decode(_ json: Data) throws -> AttentionStreamEvent {
        struct Raw: Decodable { var type: String; var item: AttentionItem? }
        let raw = try JSONDecoder().decode(Raw.self, from: json)
        switch raw.type {
        case "item": return raw.item.map(AttentionStreamEvent.item) ?? .unknown
        case "ping": return .ping
        default: return .unknown
        }
    }
}

/// A Claude Code permission prompt (`GET /api/attention/permissions`).
public struct PermissionRequest: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var sessionKey: String
    public var workspaceId: String?
    public var workspaceName: String?
    public var toolName: String
    public var toolInput: JSONValue
    public var cwd: String?
    public var createdAt: String
}

/// How to answer a permission prompt. `terminal` hands it back to Claude
/// Code's own dialog in the session.
public enum PermissionDecision: Sendable, Equatable {
    case allow
    case deny(message: String?)
    case answer([String: String])
    case terminal

    var body: JSONValue {
        switch self {
        case .allow: return .object(["behavior": .string("allow")])
        case .terminal: return .object(["behavior": .string("terminal")])
        case .deny(let message):
            var o: [String: JSONValue] = ["behavior": .string("deny")]
            if let message, !message.isEmpty { o["message"] = .string(message) }
            return .object(o)
        case .answer(let answers):
            return .object(["behavior": .string("answer"),
                            "answers": .object(answers.mapValues(JSONValue.string))])
        }
    }
}

public struct QuestionOption: Codable, Sendable, Equatable, Hashable {
    public var label: String
    public var description: String?
}

public struct QuestionItem: Codable, Sendable, Equatable {
    public var question: String
    public var header: String?
    public var options: [QuestionOption]?
    public var multiSelect: Bool?
}

/// An `ask_user` question from an agent (`GET /api/questions`).
public struct AgentQuestion: Codable, Sendable, Identifiable, Equatable {
    public struct Context: Codable, Sendable, Equatable {
        public var task: String
        public var reason: String?
    }
    public var id: String
    public var sessionKey: String?
    public var workspaceId: String?
    public var context: Context
    public var questions: [QuestionItem]
    /// `pending`, `answered` or `declined`.
    public var status: String
    public var createdAt: String
}

/// One answer per question, in the question's order.
public struct QuestionAnswer: Codable, Sendable, Equatable {
    public var selected: [String]
    public var text: String?

    public init(selected: [String], text: String? = nil) {
        self.selected = selected
        self.text = text
    }
}

// MARK: - PTY sessions

/// A PTY session the server holds (`GET /api/pty`). Exited ones stay listed
/// until they're killed or replaced.
public struct PtySession: Codable, Sendable, Identifiable, Equatable, Hashable {
    public struct Harness: Codable, Sendable, Equatable, Hashable {
        public var id: String
        public var name: String
    }

    public var id: String
    /// `agent` (a workspace's `ws-claude:`), `review` (`review-claude:`) or `shell`.
    public var kind: String
    public var workspaceId: String?
    public var cwd: String?
    public var harness: Harness?
    public var startedAt: Int64
    public var running: Bool
    public var exitCode: Int?
    /// Clients attached right now.
    public var attached: Int

    public init(id: String, kind: String, workspaceId: String? = nil, cwd: String? = nil, harness: Harness? = nil,
                startedAt: Int64 = 0, running: Bool, exitCode: Int? = nil, attached: Int = 0) {
        self.id = id
        self.kind = kind
        self.workspaceId = workspaceId
        self.cwd = cwd
        self.harness = harness
        self.startedAt = startedAt
        self.running = running
        self.exitCode = exitCode
        self.attached = attached
    }
}

// MARK: - Workspaces

public let agentSessionPrefix = "ws-claude:"
public let reviewSessionPrefix = "review-claude:"

/// True for a session the server starts itself (a workspace agent or a
/// review session). Attaching to one with nothing running would spawn a plain
/// shell under its id, so a terminal reconnects to it only while it runs.
public func isServerStartedSession(_ id: String) -> Bool {
    id.hasPrefix(agentSessionPrefix) || id.hasPrefix(reviewSessionPrefix)
}

public struct WorkspaceSummary: Codable, Sendable, Identifiable, Equatable, Hashable {
    public var id: String
    public var name: String
    /// `creating`, `active`, `archiving`, `archived` or `error`.
    public var status: String
    public var rootPath: String
    public var repoNames: [String]?
    public var slug: String?
    public var summary: String?
    public var mergedPrUrl: String?
    public var error: String?
    public var archivedAt: String?
    /// One per linked PR, the main one first. Absent on a create's answer.
    public var prs: [WorkspaceSummaryPr]?
    /// When the workspace was last opened or its agent last did something;
    /// null once archived.
    public var lastActiveAt: String?

    /// The PTY id of a workspace's agent session.
    public static func agentSessionId(workspaceId: String) -> String { "\(agentSessionPrefix)\(workspaceId)" }
}

/// A PR as the workspace list shows it: enough for one glyph.
public struct WorkspaceSummaryPr: Codable, Sendable, Equatable, Hashable {
    public var repoName: String
    public var prNumber: Int
    /// Free-form from the provider: `open`, `closed`, `merged`, or nil.
    public var prState: String?
    public var isDraft: Bool?
    /// Free-form: `clean`, `dirty`, `conflicting`, `blocked`, and so on.
    public var mergeable: String?
    /// `success`, `failure`, `pending` or `none`.
    public var checkRollup: String?
    /// `approved`, `changes_requested`, `review_required` or nil.
    public var reviewDecision: String?

    public init(repoName: String, prNumber: Int, prState: String? = nil, isDraft: Bool? = nil,
                mergeable: String? = nil, checkRollup: String? = nil, reviewDecision: String? = nil) {
        self.repoName = repoName
        self.prNumber = prNumber
        self.prState = prState
        self.isDraft = isDraft
        self.mergeable = mergeable
        self.checkRollup = checkRollup
        self.reviewDecision = reviewDecision
    }
}
