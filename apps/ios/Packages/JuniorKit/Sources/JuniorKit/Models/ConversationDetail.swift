import Foundation

/// `GET /api/conversations/{id}?mailbox=true`: header facts, the latest
/// transcript events, and the queued messages.
public struct ConversationDetail: Decodable, Sendable {
  public struct Usage: Decodable, Sendable, Hashable {
    public struct Cost: Decodable, Sendable, Hashable {
      public var total: Double?
    }

    public var inputTokens: Double?
    public var outputTokens: Double?
    public var cachedInputTokens: Double?
    public var cost: Cost?

    /// Input, output, and cached input tokens, as the dashboard totals them.
    public var totalTokens: Double { (inputTokens ?? 0) + (outputTokens ?? 0) + (cachedInputTokens ?? 0) }
  }

  public struct Brief: Decodable, Sendable, Hashable {
    public struct Content: Decodable, Sendable, Hashable {
      public var summary: String?
    }

    public var content: Content?
    public var updatedAt: Date?
  }

  public struct Mailbox: Decodable, Sendable {
    public var messages: [PendingMessage]?
    /// A parked Turn waits for the viewer to connect an account.
    public var authorization: Authorization?
  }

  /// Connect prompt for a parked Turn (participants only).
  public struct Authorization: Decodable, Sendable, Hashable {
    public var authorizationUrl: String
    public var completionText: String
    public var label: String
  }

  public var conversationId: String
  public var displayTitle: String?
  public var kind: String?
  public var status: ConversationStatus?
  public var surface: String?
  public var visibility: ConversationVisibility?
  public var startedAt: Date?
  public var lastSeenAt: Timestamp?
  public var lastProgressAt: Date?
  public var cumulativeDurationMs: Double?
  public var cumulativeUsage: Usage?
  public var channel: String?
  public var channelName: String?
  public var channelNameRedacted: Bool?
  public var locationUrl: String?
  public var annotations: [Annotation]?
  public var participants: [ActorIdentity]?
  public var actorIdentity: ActorIdentity?
  public var authors: [String: ActorIdentity]?
  public var pinnedAt: Date?
  public var archivedAt: Date?
  public var parentConversationId: String?
  public var isParticipant: Bool?
  public var subscribed: Bool?
  public var deliveryPaused: Bool?
  public var canFork: Bool?
  public var sentryConversationUrl: String?
  /// Auto-archive for this Conversation; `nil` when the viewer cannot set it.
  public var autoArchive: Bool?
  public var brief: Brief?
  public var events: [TranscriptEvent]
  /// How far the viewer has read; absent until they read.
  public var readPosition: ReadPosition?
  /// The page around the first unread event, when asked for with `unreadPage`.
  public var unreadPage: TranscriptEventPage?
  public var previousCursor: String?
  public var appendCursor: String?
  public var mailbox: Mailbox?

  public var title: String {
    let trimmed = displayTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? "Conversation" : trimmed
  }

  enum CodingKeys: String, CodingKey {
    case conversationId, displayTitle, kind, status, surface, visibility, startedAt, lastSeenAt
    case lastProgressAt, cumulativeDurationMs, cumulativeUsage, channel, channelName
    case channelNameRedacted, locationUrl, annotations, participants, actorIdentity, authors
    case pinnedAt, archivedAt, parentConversationId, isParticipant, subscribed, deliveryPaused, canFork
    case sentryConversationUrl, autoArchive, brief, events, previousCursor, appendCursor, mailbox
    case readPosition, unreadPage
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    conversationId = try c.decode(String.self, forKey: .conversationId)
    displayTitle = try c.decodeIfPresent(String.self, forKey: .displayTitle)
    kind = try c.decodeIfPresent(String.self, forKey: .kind)
    status = try c.decodeIfPresent(ConversationStatus.self, forKey: .status)
    surface = try c.decodeIfPresent(String.self, forKey: .surface)
    visibility = try c.decodeIfPresent(ConversationVisibility.self, forKey: .visibility)
    startedAt = try c.decodeIfPresent(Date.self, forKey: .startedAt)
    lastSeenAt = try c.decodeIfPresent(Timestamp.self, forKey: .lastSeenAt)
    lastProgressAt = try c.decodeIfPresent(Date.self, forKey: .lastProgressAt)
    cumulativeDurationMs = try c.decodeIfPresent(Double.self, forKey: .cumulativeDurationMs)
    cumulativeUsage = try c.decodeIfPresent(Usage.self, forKey: .cumulativeUsage)
    channel = try c.decodeIfPresent(String.self, forKey: .channel)
    channelName = try c.decodeIfPresent(String.self, forKey: .channelName)
    channelNameRedacted = try c.decodeIfPresent(Bool.self, forKey: .channelNameRedacted)
    locationUrl = try c.decodeIfPresent(String.self, forKey: .locationUrl)
    annotations = try c.decodeIfPresent([Annotation].self, forKey: .annotations)
    participants = try c.decodeIfPresent([ActorIdentity].self, forKey: .participants)
    actorIdentity = try c.decodeIfPresent(ActorIdentity.self, forKey: .actorIdentity)
    authors = try? c.decodeIfPresent([String: ActorIdentity].self, forKey: .authors)
    pinnedAt = try c.decodeIfPresent(Date.self, forKey: .pinnedAt)
    archivedAt = try c.decodeIfPresent(Date.self, forKey: .archivedAt)
    parentConversationId = try c.decodeIfPresent(String.self, forKey: .parentConversationId)
    isParticipant = try c.decodeIfPresent(Bool.self, forKey: .isParticipant)
    subscribed = try c.decodeIfPresent(Bool.self, forKey: .subscribed)
    deliveryPaused = try c.decodeIfPresent(Bool.self, forKey: .deliveryPaused)
    canFork = try c.decodeIfPresent(Bool.self, forKey: .canFork)
    sentryConversationUrl = try c.decodeIfPresent(String.self, forKey: .sentryConversationUrl)
    autoArchive = try? c.decodeIfPresent(Bool.self, forKey: .autoArchive)
    brief = try? c.decodeIfPresent(Brief.self, forKey: .brief)
    events = try c.decodeIfPresent([TranscriptEvent].self, forKey: .events) ?? []
    readPosition = try? c.decodeIfPresent(ReadPosition.self, forKey: .readPosition)
    unreadPage = try? c.decodeIfPresent(TranscriptEventPage.self, forKey: .unreadPage)
    previousCursor = try c.decodeIfPresent(String.self, forKey: .previousCursor)
    appendCursor = try c.decodeIfPresent(String.self, forKey: .appendCursor)
    mailbox = try? c.decodeIfPresent(Mailbox.self, forKey: .mailbox)
  }
}

/// How far the signed-in viewer has read one transcript.
public struct ReadPosition: Codable, Sendable, Hashable {
  public var lastReadSeq: Int

  public init(lastReadSeq: Int) { self.lastReadSeq = lastReadSeq }
}

/// A message waiting in the Conversation's mailbox for the next safe point.
public struct PendingMessage: Decodable, Sendable, Hashable, Identifiable {
  public struct Attachment: Decodable, Sendable, Hashable {
    public var id: String?
    public var filename: String?
    public var contentType: String?
  }

  public var messageId: String
  public var inboundMessageId: String?
  public var text: String?
  public var redacted: Bool?
  public var delivery: String?
  public var source: String?
  public var createdAt: Date?
  public var actorIdentity: ActorIdentity?
  public var attachments: [Attachment]?

  public var id: String { messageId }
}

/// One page of `GET /api/conversations/{id}/events`.
public struct TranscriptEventPage: Decodable, Sendable {
  public var events: [TranscriptEvent]
  public var previousCursor: String?
}

/// One stored transcript event. Order by `seq`, never by time.
public struct TranscriptEvent: Decodable, Sendable, Hashable {
  public var seq: Int
  public var createdAt: Date?
  public var data: EventData
}

public struct ToolCall: Decodable, Sendable, Hashable {
  public var toolCallId: String
  public var name: String
  public var status: String?
  public var startedAt: Date?
  public var startedSeq: Int?
  public var input: JSONValue?
}

public struct AssistantPart: Decodable, Sendable, Hashable {
  public var type: String
  public var text: String?
  public var toolCallId: String?
}

/// The `data` of a transcript event, by `type`. Unknown types decode as
/// `.other` and are skipped.
public enum EventData: Decodable, Sendable, Hashable {
  case message(MessageEvent)
  case assistantMessage(parts: [AssistantPart])
  case toolCalls(calls: [ToolCall], assistantParts: [AssistantPart]?)
  case turnLifecycle(
    turnId: String?, state: String, failureCode: String?, failureReason: String?, inputMessageIds: [String])
  /// The agent read this message, though no one addressed it.
  case messageHandled(messageId: String)
  /// A plugin's event in the transcript, such as captured memories.
  case structuredEvent(title: String, namespace: String?, name: String?)
  /// History was summarized to fit the model's context.
  case compaction
  case turnContext(turnId: String?, pluginName: String?, kind: String?, memoryCount: Int)
  case subagent(SubagentEvent)
  /// Junior's text posted to another tool, such as a GitHub comment.
  case replyPosted(text: String, plugin: String?)
  /// Files Junior delivered to the Location.
  case attachmentsDelivered(filenames: [String])
  case other(String)

  public struct MessageEvent: Decodable, Sendable, Hashable {
    public struct Attachment: Decodable, Sendable, Hashable {
      public var id: String?
      public var filename: String?
      public var contentType: String?
    }

    public var messageId: String
    public var role: String
    public var text: String?
    public var redacted: Bool?
    public var source: String?
    public var actorIdentity: ActorIdentity?
    public var actorIdentityId: String?
    public var agentInvocationId: String?
    public var eventType: String?
    public var explicitMention: Bool?
    public var quiet: Bool?
    public var attachments: [Attachment]?
  }

  public struct SubagentEvent: Decodable, Sendable, Hashable {
    public var childConversationId: String?
    public var childKind: String?
    public var status: String?
    public var title: String?
    public var agentName: String?
    public var startedSeq: Int?
    public var parentToolCallId: String?
  }

  enum Keys: String, CodingKey {
    case type, parts, calls, assistant, turnId, state, failureCode, failureReason, pluginName, kind
    case content, text, plugin, attachments, inputMessageIds, messageId, presentation, namespace, name
  }

  private struct Assistant: Decodable { var parts: [AssistantPart]? }
  private struct Delivered: Decodable { var filename: String? }
  private struct Presentation: Decodable { var title: String? }
  private struct ContextContent: Decodable { var memories: [JSONValue]? }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    let type = try c.decode(String.self, forKey: .type)
    switch type {
    case "message":
      self = .message(try MessageEvent(from: decoder))
    case "assistant_message":
      self = .assistantMessage(parts: try c.decodeIfPresent([AssistantPart].self, forKey: .parts) ?? [])
    case "tool_calls":
      self = .toolCalls(
        calls: try c.decodeIfPresent([ToolCall].self, forKey: .calls) ?? [],
        assistantParts: (try? c.decodeIfPresent(Assistant.self, forKey: .assistant))?.parts)
    case "turn_lifecycle":
      self = .turnLifecycle(
        turnId: try c.decodeIfPresent(String.self, forKey: .turnId),
        state: try c.decodeIfPresent(String.self, forKey: .state) ?? "",
        failureCode: try c.decodeIfPresent(String.self, forKey: .failureCode),
        failureReason: try c.decodeIfPresent(String.self, forKey: .failureReason),
        inputMessageIds: (try? c.decodeIfPresent([String].self, forKey: .inputMessageIds)) ?? [])
    case "message_handled":
      self = .messageHandled(messageId: try c.decodeIfPresent(String.self, forKey: .messageId) ?? "")
    case "structured_event":
      self = .structuredEvent(
        title: (try? c.decodeIfPresent(Presentation.self, forKey: .presentation))?.title ?? "Event",
        namespace: try? c.decodeIfPresent(String.self, forKey: .namespace),
        name: try? c.decodeIfPresent(String.self, forKey: .name))
    case "compaction":
      self = .compaction
    case "turn_context":
      let content = try? c.decodeIfPresent(ContextContent.self, forKey: .content)
      self = .turnContext(
        turnId: try c.decodeIfPresent(String.self, forKey: .turnId),
        pluginName: try c.decodeIfPresent(String.self, forKey: .pluginName),
        kind: try c.decodeIfPresent(String.self, forKey: .kind),
        memoryCount: content?.memories?.count ?? 0)
    case "subagent":
      self = .subagent(try SubagentEvent(from: decoder))
    case "reply_posted":
      self = .replyPosted(
        text: try c.decodeIfPresent(String.self, forKey: .text) ?? "",
        plugin: try? c.decodeIfPresent(String.self, forKey: .plugin))
    case "attachments_delivered":
      let delivered = (try? c.decodeIfPresent([Delivered].self, forKey: .attachments)) ?? []
      self = .attachmentsDelivered(filenames: delivered.compactMap(\.filename))
    default:
      self = .other(type)
    }
  }
}

/// `GET /api/conversations/{id}/plan`: the Conversation's durable Plan.
public struct ConversationPlan: Decodable, Sendable {
  public struct Item: Decodable, Sendable, Hashable, Identifiable {
    public struct Assignee: Decodable, Sendable, Hashable {
      public var kind: String
      public var name: String?
    }

    public var id: Int
    /// Absent when the viewer may not read the item.
    public var title: String?
    public var notes: String?
    public var status: String
    public var assignee: Assignee?

    /// Done and cancelled items are closed.
    public var isOpen: Bool { status != "done" && status != "cancelled" }
  }

  public var items: [Item]
}
