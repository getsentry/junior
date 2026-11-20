import Foundation

// Results of Junior's MCP tools. Each type mirrors the zod output schema of
// its tool in `packages/junior/src/api/mcp`.

/// One Conversation (`mcpConversationSchema`).
public struct MCPConversation: Decodable, Sendable, Hashable, Identifiable {
  public var conversationId: String
  public var title: String
  public var status: ConversationStatus
  /// A Turn runs or waits to start. `status` can read `needs_input` meanwhile,
  /// so live views poll and show work on this, not on `status`.
  public var turnActive: Bool
  /// `slack`, `api` (the dashboard or MCP), `scheduler`, or `internal`.
  public var surface: String
  public var channelName: String?
  public var locationUrl: String?
  public var startedAt: Timestamp
  /// Newest activity. Archive takes this exact value.
  public var lastSeenAt: Timestamp
  public var archivedAt: Timestamp?
  public var pinnedAt: Timestamp?
  public var url: String?

  public var id: String { conversationId }

  private enum CodingKeys: String, CodingKey {
    case conversationId, title, status, turnActive, surface, channelName, locationUrl, startedAt, lastSeenAt
    case archivedAt, pinnedAt, url
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    conversationId = try container.decode(String.self, forKey: .conversationId)
    title = try container.decode(String.self, forKey: .title)
    status = try container.decode(ConversationStatus.self, forKey: .status)
    // Junior 0.310 and older send no `turnActive`; their `active` status
    // covers a running Turn, so a phone stays usable against an older server.
    turnActive =
      try container.decodeIfPresent(Bool.self, forKey: .turnActive)
      ?? (status == .working || status.rawValue == "active")
    surface = try container.decode(String.self, forKey: .surface)
    channelName = try container.decodeIfPresent(String.self, forKey: .channelName)
    locationUrl = try container.decodeIfPresent(String.self, forKey: .locationUrl)
    startedAt = try container.decode(Timestamp.self, forKey: .startedAt)
    lastSeenAt = try container.decode(Timestamp.self, forKey: .lastSeenAt)
    archivedAt = try container.decodeIfPresent(Timestamp.self, forKey: .archivedAt)
    pinnedAt = try container.decodeIfPresent(Timestamp.self, forKey: .pinnedAt)
    url = try container.decodeIfPresent(String.self, forKey: .url)
  }

  /// Where it lives, as the dashboard labels it.
  public var locationLabel: String? {
    switch surface {
    case "slack": channelName.map { "#\($0)" } ?? "Slack"
    case "scheduler": "Automation"
    default: nil
    }
  }
}

public struct ConversationList: Decodable, Sendable {
  public var conversations: [MCPConversation]
}

/// A Conversation's Brief: its summary, intent, outcome, and state.
public struct Brief: Decodable, Sendable, Hashable {
  public struct Outcome: Decodable, Sendable, Hashable {
    /// `in_progress`, `answered`, `done`, `partial`, `blocked`, or `abandoned`.
    public var status: String
    public var text: String
  }

  public struct Decision: Decodable, Sendable, Hashable {
    public var text: String
    public var by: String?
    public var kind: String
  }

  public struct Link: Decodable, Sendable, Hashable {
    /// `code_change`, `resource`, or `url`.
    public var kind: String
    public var label: String
    public var url: String
    public var status: String?
  }

  public var summary: String
  public var intent: String
  public var outcome: Outcome
  public var decisions: [Decision]
  public var facts: [String]
  public var links: [Link]
  public var updatedAt: Timestamp
}

public struct Attachment: Decodable, Sendable, Hashable {
  public var filename: String
  public var contentType: String
  public var bytes: Int
}

/// One user or assistant message (`mcpMessageSchema`). Tool calls are not
/// part of the public API.
public struct MCPMessage: Decodable, Sendable, Hashable, Identifiable {
  public var seq: Int
  public var messageId: String
  public var createdAt: Timestamp
  /// `user` or `assistant`.
  public var role: String
  public var author: String?
  public var text: String
  public var attachments: [Attachment]?

  public var id: Int { seq }
  public var isAssistant: Bool { role == "assistant" }
}

/// An accepted message that no Turn has read yet.
public struct PendingMessage: Decodable, Sendable, Hashable, Identifiable {
  public var messageId: String
  public var createdAt: Timestamp
  public var author: String?
  public var text: String
  public var attachments: [Attachment]?
  /// `defer` waits for the running Turn; `interrupt` joins it.
  public var delivery: String

  public var id: String { messageId }
}

/// An account that a parked Turn waits for the viewer to connect.
public struct PendingAuthorization: Decodable, Sendable, Hashable {
  public var label: String
  public var url: String
}

/// `getConversation`: the state of one Conversation and a cursor to follow it.
public struct ConversationState: Decodable, Sendable {
  public var conversation: MCPConversation
  public var brief: Brief?
  /// Newest assistant message. Set only without `after`.
  public var lastReply: MCPMessage?
  /// Messages after `after`, oldest first. Set only with `after`.
  public var messages: [MCPMessage]?
  public var hasMore: Bool?
  public var pendingMessages: [PendingMessage]
  public var authorization: PendingAuthorization?
  public var cursor: String
}

/// `listConversationMessages`: newest last.
public struct MessagePage: Decodable, Sendable {
  public var messages: [MCPMessage]
  /// Set when older messages can exist.
  public var nextCursor: String?
}

/// `sendMessage` and `createConversation`.
public struct AcceptedMessage: Decodable, Sendable {
  public var conversationId: String
  public var messageId: String
  /// `accepted`, or `duplicate` when the idempotency key was already used.
  public var status: String
  public var pendingMessages: [PendingMessage]?
  public var authorization: PendingAuthorization?
  public var cursor: String
  public var url: String?
}

/// One open Review item (`mcpReviewItemSchema`). Answers happen on the web.
public struct ReviewItem: Decodable, Sendable, Hashable, Identifiable {
  public struct Subject: Decodable, Sendable, Hashable {
    public var id: String
    public var title: String?
    public var url: String?
  }

  public var id: String
  /// `notice` or `action`.
  public var kind: String
  /// `open`, `done`, or `dismissed`.
  public var status: String
  public var title: String
  public var body: String
  public var question: String?
  /// Names or emails. Empty when anyone can act.
  public var assignees: [String]
  public var canAct: Bool
  public var conversationIds: [String]
  public var subject: Subject?
  public var createdAt: Timestamp
  public var updatedAt: Timestamp
  public var url: String?
}

public struct ReviewItemList: Decodable, Sendable {
  public var items: [ReviewItem]
  public var truncated: Bool
}

public struct ReviewItemResult: Decodable, Sendable {
  public var item: ReviewItem
}

/// What an Automation runs: an instruction, or a skill with context.
public struct AutomationTask: Decodable, Sendable, Hashable {
  public var kind: String
  public var instruction: String?
  public var skill: String?
  public var context: String?

  /// The task as one line of text.
  public var text: String {
    switch kind {
    case "skill": [skill.map { "/\($0)" }, context].compactMap { $0 }.joined(separator: " ")
    default: instruction ?? ""
    }
  }
}

/// One Automation (`mcpAutomationSchema`). Changes happen on the web.
public struct Automation: Decodable, Sendable, Hashable, Identifiable {
  public var id: String
  /// `scheduled` or `event`.
  public var kind: String
  public var title: String
  public var task: AutomationTask
  /// `active`, `blocked`, `paused`, or `completed`.
  public var status: String
  public var statusReason: String?
  /// The schedule, or the events and filters that start a run.
  public var trigger: String
  public var nextRunAt: Timestamp?
  /// Slack channel that gets the results.
  public var destination: String
  public var createdBy: String
  public var ownedByYou: Bool
  public var lastRunAt: Timestamp?
  /// `blocked`, `completed`, or `failed`.
  public var lastRunStatus: String?
  public var lastConversationId: String?
  public var url: String?
}

public struct AutomationList: Decodable, Sendable {
  public var automations: [Automation]
  public var total: Int
}

public struct AutomationRun: Decodable, Sendable, Hashable {
  public var executedAt: Timestamp
  public var status: String
  public var error: String?
  public var conversationId: String?
}

public struct AutomationDetail: Decodable, Sendable {
  public var automation: Automation
  public var runs: [AutomationRun]
}
