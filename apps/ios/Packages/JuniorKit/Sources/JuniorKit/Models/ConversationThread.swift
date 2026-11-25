/// A visible Thread under a root, from the dashboard feed's `threads`. Tasks
/// never show.
public struct ConversationThread: Decodable, Sendable, Hashable, Identifiable {
  public var conversationId: String
  public var displayTitle: String
  public var status: ConversationStatus
  public var turnActive: Bool
  public var lastSeenAt: Timestamp
  /// Its own visible Threads.
  public var threads: [ConversationThread]?

  public var id: String { conversationId }
}

/// The dashboard feed (`GET /api/conversations`), read only for the Threads
/// that it nests under each root.
public struct ConversationFeed: Decodable, Sendable {
  public struct Root: Decodable, Sendable {
    public var conversationId: String
    public var threads: [ConversationThread]?
  }

  public var conversations: [Root]

  /// Each root's Threads, by root id. Roots with none are left out.
  public var threadsByRoot: [String: [ConversationThread]] {
    var threads: [String: [ConversationThread]] = [:]
    for root in conversations { if let nested = root.threads, !nested.isEmpty { threads[root.conversationId] = nested } }
    return threads
  }
}
