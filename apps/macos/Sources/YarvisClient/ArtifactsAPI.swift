import Foundation

/// A document the assistant wrote for the user (sidecar `artifacts/`).
public struct Artifact: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var title: String
    /// `markdown` or `excalidraw`.
    public var format: String
    public var createdBy: String?
    /// True when its content came from outside the conversation, so its
    /// links must not move the app around.
    public var untrusted: Bool
    public var content: String
    public var createdAt: String
    public var updatedAt: String

    public init(id: String, title: String, format: String, createdBy: String? = nil, untrusted: Bool = false,
                content: String, createdAt: String = "", updatedAt: String = "") {
        self.id = id
        self.title = title
        self.format = format
        self.createdBy = createdBy
        self.untrusted = untrusted
        self.content = content
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// One frame of an artifact's change stream. Only the type matters: the
/// content is read again on `updated`.
public enum ArtifactStreamEvent: Sendable, Equatable {
    case updated
    case deleted
    case other(String)

    public static func decode(_ json: Data) throws -> ArtifactStreamEvent {
        struct Raw: Decodable { var type: String }
        switch try JSONDecoder().decode(Raw.self, from: json).type {
        case "updated": return .updated
        case "deleted": return .deleted
        case let type: return .other(type)
        }
    }
}

extension YarvisClient {
    /// The artifact, or nil when it was deleted.
    public func artifact(id: String) async throws -> Artifact? {
        do {
            return try await get(Artifact.self, Self.sidecar("/api/artifacts/\(encodePathSegment(id))"))
        } catch YarvisError.http(status: 404, _, _) {
            return nil
        }
    }

    public func artifactStream(id: String) throws -> AsyncThrowingStream<ArtifactStreamEvent, Error> {
        decodedEventStream(try request("GET", Self.sidecar("/api/artifacts/\(encodePathSegment(id))/stream")),
                           ArtifactStreamEvent.decode)
    }
}
