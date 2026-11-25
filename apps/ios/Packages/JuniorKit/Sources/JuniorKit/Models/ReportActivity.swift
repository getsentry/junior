/// Reasoning and tool calls of one dashboard report event, in the order the
/// event holds them. Tool input and output are left out. Other events, such
/// as messages, have no parts.
public struct ReportActivity: Decodable, Sendable, Hashable, Identifiable {
  public enum Part: Sendable, Hashable {
    case reasoning(String)
    case toolCall(ToolCall)
  }

  /// One sighting of a tool call. It shows again with the same id when it ends.
  public struct ToolCall: Decodable, Sendable, Hashable {
    public var toolCallId: String
    public var name: String
    /// `running`, `completed`, or `error`.
    public var status: String
    public var startedAt: Timestamp?
  }

  public var seq: Int
  public var createdAt: Timestamp
  public var parts: [Part]

  public var id: Int { seq }

  private enum CodingKeys: String, CodingKey { case seq, createdAt, data }

  private struct EventData: Decodable {
    struct Reasoning: Decodable {
      var type: String
      /// Absent when the reasoning is redacted.
      var text: String?
      var toolCallId: String?
    }
    struct Assistant: Decodable { var parts: [Reasoning] }
    var type: String
    var parts: [Reasoning]?
    var calls: [ToolCall]?
    var assistant: Assistant?
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    seq = try container.decode(Int.self, forKey: .seq)
    createdAt = try container.decode(Timestamp.self, forKey: .createdAt)
    let data = try container.decode(EventData.self, forKey: .data)
    switch data.type {
    case "assistant_message":
      parts = (data.parts ?? []).compactMap { $0.text.map(Part.reasoning) }
    case "tool_calls":
      let calls = data.calls ?? []
      // `assistant` orders reasoning and the calls it made. A result event
      // has no `assistant`.
      let ordered = data.assistant?.parts ?? calls.map { EventData.Reasoning(type: "tool_call", toolCallId: $0.toolCallId) }
      parts = ordered.compactMap { part in
        if part.type == "reasoning" { return part.text.map(Part.reasoning) }
        return calls.first { $0.toolCallId == part.toolCallId }.map(Part.toolCall)
      }
    default:
      parts = []
    }
  }
}

/// A page of dashboard report events, as the Conversation detail
/// (`GET /api/conversations/:id`) and its events route return them.
public struct ReportActivityPage: Decodable, Sendable {
  public var events: [ReportActivity]
  /// Pass as `before` to the events route for older events.
  public var previousCursor: String?
  /// Pass as `after` to the detail for newer events.
  public var appendCursor: String?

  /// The events that hold reasoning or tool calls.
  public var activity: [ReportActivity] { events.filter { !$0.parts.isEmpty } }
}
