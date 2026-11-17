import Foundation

/// A string enum that keeps unknown server values instead of failing to
/// decode, so a new status from a newer Junior never breaks the app.
public protocol OpenEnum: RawRepresentable, Codable, Hashable, Sendable where RawValue == String {
  init(rawValue: String)
}

extension OpenEnum {
  public init(from decoder: Decoder) throws {
    self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}

public struct ConversationStatus: OpenEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let active = Self(rawValue: "active")
  public static let completed = Self(rawValue: "completed")
  public static let failed = Self(rawValue: "failed")
  public static let stopped = Self(rawValue: "stopped")
}

public struct ConversationVisibility: OpenEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let `public` = Self(rawValue: "public")
  public static let `private` = Self(rawValue: "private")
}

/// A person as the dashboard shows them (Actor or Participant).
public struct ActorIdentity: Codable, Hashable, Sendable {
  public var email: String?
  public var fullName: String?
  public var slackUserName: String?
  public var userName: String?

  public init(email: String? = nil, fullName: String? = nil, slackUserName: String? = nil) {
    self.email = email
    self.fullName = fullName
    self.slackUserName = slackUserName
  }

  /// Name shown next to a message or avatar.
  public var displayName: String {
    for candidate in [fullName, userName, slackUserName, email?.split(separator: "@").first.map(String.init)] {
      if let candidate, !candidate.trimmingCharacters(in: .whitespaces).isEmpty { return candidate }
    }
    return "Someone"
  }

  /// Up to two initials, as the dashboard avatar shows them.
  public var initials: String {
    let words = displayName.split(whereSeparator: { $0 == " " || $0 == "." || $0 == "_" || $0 == "-" })
    let letters = words.prefix(2).compactMap { $0.first.map { String($0).uppercased() } }
    return letters.isEmpty ? "?" : letters.joined()
  }
}

/// Saved facts about an object that a Conversation created or changed.
public struct Annotation: Codable, Hashable, Sendable {
  public var kind: String?
  public var key: String
  public var label: String
  public var objectType: String?
  public var title: String?
  public var description: String?
  public var url: String?
  public var status: String?
  public var displayType: String?
  public var plugin: String?
}

public struct SidebarAnnotation: Codable, Hashable, Sendable {
  public var key: String
  public var label: String
  public var icon: String?
}

public struct ActivityPreview: Codable, Hashable, Sendable {
  public var createdAt: Date?
  public var role: String?
  public var text: String
}

/// One row of `GET /api/conversations`.
public struct ConversationSummary: Codable, Hashable, Sendable, Identifiable {
  public var conversationId: String
  public var displayTitle: String?
  public var activityPreview: ActivityPreview?
  public var kind: String?
  public var isParticipant: Bool?
  public var status: ConversationStatus?
  public var startedAt: Date?
  public var lastSeenAt: Date?
  public var lastMessageAt: Date?
  public var lastProgressAt: Date?
  public var surface: String?
  public var actorIdentity: ActorIdentity?
  public var participants: [ActorIdentity]?
  public var pinnedAt: Date?
  public var pinPosition: Int?
  public var channel: String?
  public var channelName: String?
  public var channelNameRedacted: Bool?
  public var locationUrl: String?
  public var annotations: [Annotation]?
  public var sidebarAnnotations: [SidebarAnnotation]?
  public var visibility: ConversationVisibility?
  public var archivedAt: Date?
  public var awaitingAuthorization: Bool?
  public var parentConversationId: String?

  public var id: String { conversationId }

  /// Title with the dashboard's fallback.
  public var title: String {
    let trimmed = displayTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? "Conversation" : trimmed
  }

  /// Time the list sorts and groups by.
  public var activityAt: Date? { lastMessageAt ?? lastSeenAt }

  public var isPrivate: Bool { visibility == .private }
}

public struct ConversationFeed: Codable, Sendable {
  public var conversations: [ConversationSummary]
  public var nextCursor: String?
}

/// `GET /api/review-items/waiting-conversations`: Conversations that wait on
/// the viewer, and since when.
public struct WaitingConversations: Codable, Sendable {
  public struct Entry: Codable, Sendable, Hashable {
    public struct Item: Codable, Sendable, Hashable {
      public var plugin: String?
      public var title: String
    }

    public var conversationId: String
    public var items: [Item]
    public var waitingSince: Date?
  }

  public var conversations: [Entry]
}

/// `GET /api/versions`: opaque tokens that change when data changes.
public struct DataVersions: Codable, Sendable, Equatable {
  public var conversation: String?
  public var conversations: String?
  public var reviewItems: String?
  public var spend: String?
}
