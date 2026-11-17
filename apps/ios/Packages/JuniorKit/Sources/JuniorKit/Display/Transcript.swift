import Foundation

/// The rows of a transcript, built the way the dashboard builds them
/// (`eventTranscript.ts`, `transcriptListRows.ts`): messages stay rows, and
/// runs of reasoning and tool calls fold into one activity row.
public struct TranscriptModel: Sendable {
  public var rows: [TranscriptRow]
  /// The agent is working on a started Turn.
  public var responding: Bool

  public init(rows: [TranscriptRow], responding: Bool) {
    self.rows = rows
    self.responding = responding
  }
}

public enum TranscriptRow: Identifiable, Sendable, Hashable {
  case message(TranscriptMessage)
  case activity(TranscriptActivity)
  case failure(TranscriptFailure)
  case thread(TranscriptThread)
  /// The agent responds but has shown no activity yet.
  case thinking

  public var id: String {
    switch self {
    case .message(let message): "message-\(message.id)"
    case .activity(let activity): activity.id
    case .failure(let failure): "failure-\(failure.seq)"
    case .thread(let thread): "thread-\(thread.seq)"
    case .thinking: "thinking"
    }
  }
}

public struct TranscriptMessage: Sendable, Hashable, Identifiable {
  public enum Speaker: Sendable, Hashable {
    case agent
    case person(ActorIdentity?)
    case parentAgent
    case system
  }

  public var id: String
  public var seq: Int
  public var speaker: Speaker
  public var createdAt: Date?
  public var text: String
  public var redacted: Bool
  public var fromSlack: Bool
  public var attachments: [String]
  /// "Recalled N memories" chip count on the reply that ends a Turn.
  public var recalledMemories: Int
}

public struct TranscriptActivity: Sendable, Hashable, Identifiable {
  public var id: String
  public var entries: [ActivityEntry]
  public var startedAt: Date?
  public var endedAt: Date?
  public var isLive: Bool

  /// "2 events · 5.0s".
  public var summary: String {
    let count = entries.count == 1 ? "1 event" : "\(entries.count) events"
    guard let startedAt, let endedAt, endedAt >= startedAt else { return count }
    return "\(count) · \(formatEventDuration(endedAt.timeIntervalSince(startedAt) * 1000))"
  }

  /// Latest non-empty reasoning text, shown under the live label.
  public var latestReasoning: String? {
    entries.reversed().compactMap {
      if case .reasoning(let text) = $0.kind, !text.isEmpty { return text }
      return nil
    }.first
  }

  /// The tool call still running, if any.
  public var runningTool: ActivityEntry? {
    entries.last { if case .tool(_, _, .running) = $0.kind { return true } else { return false } }
  }
}

public struct ActivityEntry: Sendable, Hashable, Identifiable {
  public enum ToolState: Sendable, Hashable { case running, completed, error }

  public enum Kind: Sendable, Hashable {
    case reasoning(String)
    case tool(name: String, preview: String, state: ToolState)
  }

  public var id: String
  public var kind: Kind
  public var startedAt: Date?
  public var endedAt: Date?
}

public struct TranscriptFailure: Sendable, Hashable {
  public var seq: Int
  public var title: String
  public var detail: String?
}

public struct TranscriptThread: Sendable, Hashable {
  public var seq: Int
  public var conversationId: String?
  public var title: String
  public var status: String?
  public var startedAt: Date?
}

/// Build transcript rows from stored events, in `seq` order.
public func buildTranscript(
  events: [TranscriptEvent], status: ConversationStatus?, fallbackAuthor: ActorIdentity?,
  authors: [String: ActorIdentity] = [:], argumentOrder: [String: [String]] = [:]
) -> TranscriptModel {
  let sorted = events.sorted { $0.seq < $1.seq }
  let timeBySeq = Dictionary(sorted.map { ($0.seq, $0.createdAt) }, uniquingKeysWith: { a, _ in a })

  enum Entry {
    case message(TranscriptMessage)
    case activity(ActivityEntry, seq: Int)
    case failure(TranscriptFailure)
    case thread(TranscriptThread)
  }

  var entries: [(seq: Int, entry: Entry)] = []
  var toolIndex: [String: Int] = [:]
  var turnMessage: [String: String] = [:]
  var recalledByMessage: [String: Int] = [:]
  var lastUserMessageId: String?
  var lastLifecycle: String?

  func toolEntry(_ call: ToolCall, seq: Int, at time: Date?) -> ActivityEntry {
    let state: ActivityEntry.ToolState =
      switch call.status {
      case "completed": .completed
      case "error", "failed": .error
      default: .running
      }
    let start = call.startedAt ?? call.startedSeq.flatMap { timeBySeq[$0] ?? nil } ?? time
    return ActivityEntry(
      id: "tool-\(call.toolCallId)",
      kind: .tool(
        name: call.name,
        preview: toolCallPreview(name: call.name, input: call.input, argumentOrder: argumentOrder[call.toolCallId]),
        state: state),
      startedAt: start, endedAt: state == .running ? nil : time)
  }

  for event in sorted {
    let time = event.createdAt
    switch event.data {
    case .message(let message):
      if message.role == "user", message.explicitMention == false, message.eventType == nil { continue }
      let speaker: TranscriptMessage.Speaker
      if message.agentInvocationId != nil {
        speaker = .parentAgent
      } else if message.role == "assistant" {
        speaker = .agent
      } else if message.role == "system" {
        speaker = .system
      } else {
        speaker = .person(
          message.actorIdentityId.flatMap { authors[$0] } ?? message.actorIdentity ?? fallbackAuthor)
      }
      if message.role == "user" { lastUserMessageId = message.messageId }
      entries.append(
        (
          event.seq,
          .message(
            TranscriptMessage(
              id: message.messageId, seq: event.seq, speaker: speaker, createdAt: time,
              text: message.text ?? "", redacted: message.redacted == true,
              fromSlack: message.source == "slack",
              attachments: message.attachments?.compactMap(\.filename) ?? [], recalledMemories: 0))
        ))
    case .assistantMessage(let parts):
      for (index, part) in parts.enumerated() where part.type == "reasoning" {
        let reasoning = ActivityEntry(
          id: "reasoning-\(event.seq)-\(index)", kind: .reasoning(part.text ?? ""), startedAt: time,
          endedAt: time)
        entries.append((event.seq, .activity(reasoning, seq: event.seq)))
      }
    case .toolCalls(let calls, let assistantParts):
      if let assistantParts {
        for (index, part) in assistantParts.enumerated() where part.type == "reasoning" {
          let reasoning = ActivityEntry(
            id: "reasoning-\(event.seq)-\(index)", kind: .reasoning(part.text ?? ""), startedAt: time,
            endedAt: time)
          entries.append((event.seq, .activity(reasoning, seq: event.seq)))
        }
      }
      for call in calls {
        let entry = toolEntry(call, seq: event.seq, at: time)
        if let index = toolIndex[call.toolCallId], case .activity(let existing, let seq) = entries[index].entry {
          var updated = entry
          updated.startedAt = existing.startedAt ?? entry.startedAt
          entries[index] = (entries[index].seq, .activity(updated, seq: seq))
        } else {
          toolIndex[call.toolCallId] = entries.count
          entries.append((call.startedSeq ?? event.seq, .activity(entry, seq: event.seq)))
        }
      }
    case .turnLifecycle(let turnId, let state, let code, let reason):
      lastLifecycle = state
      if state == "started", let turnId, let lastUserMessageId { turnMessage[turnId] = lastUserMessageId }
      if state == "failed" {
        entries.append(
          (event.seq, .failure(TranscriptFailure(seq: event.seq, title: failureTitle(code), detail: reason))))
      }
    case .turnContext(let turnId, let plugin, let kind, let count):
      if plugin == "memory", kind == "recall", count > 0, let turnId, let messageId = turnMessage[turnId] {
        recalledByMessage[messageId, default: 0] += count
      }
    case .subagent(let subagent):
      entries.append(
        (
          event.seq,
          .thread(
            TranscriptThread(
              seq: event.seq, conversationId: subagent.childConversationId,
              title: subagent.title ?? subagent.agentName ?? "Thread", status: subagent.status,
              startedAt: time))
        ))
    case .other:
      continue
    }
  }

  entries.sort { $0.seq < $1.seq }

  // Group consecutive activity into rows.
  var rows: [TranscriptRow] = []
  var pending: [ActivityEntry] = []
  var pendingSeq = 0
  func flush() {
    guard !pending.isEmpty else { return }
    rows.append(
      .activity(
        TranscriptActivity(
          id: "activity-\(pendingSeq)", entries: pending,
          startedAt: pending.compactMap(\.startedAt).min(),
          endedAt: pending.compactMap { $0.endedAt ?? $0.startedAt }.max(), isLive: false)))
    pending = []
  }
  for (seq, entry) in entries {
    switch entry {
    case .activity(let activity, _):
      if pending.isEmpty { pendingSeq = seq }
      pending.append(activity)
    case .message(let message):
      flush()
      rows.append(.message(message))
    case .failure(let failure):
      flush()
      rows.append(.failure(failure))
    case .thread(let thread):
      flush()
      rows.append(.thread(thread))
    }
  }
  flush()

  // Put each Turn's recalled-memory chip on the reply that ends it.
  var currentPrompt: String?
  var lastReplyIndex: Int?
  func attachChip() {
    guard let prompt = currentPrompt, let count = recalledByMessage[prompt], count > 0,
      let index = lastReplyIndex, case .message(var reply) = rows[index]
    else { return }
    reply.recalledMemories = count
    rows[index] = .message(reply)
  }
  for (index, row) in rows.enumerated() {
    guard case .message(let message) = row else { continue }
    if case .person = message.speaker {
      attachChip()
      currentPrompt = message.id
      lastReplyIndex = nil
    } else if case .agent = message.speaker {
      lastReplyIndex = index
    }
  }
  attachChip()

  let responding = status == .active && lastLifecycle == "started"
  if responding {
    let lastMessage = rows.lastIndex { if case .message = $0 { return true } else { return false } }
    if let liveIndex = rows.lastIndex(where: { if case .activity = $0 { return true } else { return false } }),
      liveIndex > (lastMessage ?? -1), case .activity(var live) = rows[liveIndex]
    {
      live.isLive = true
      rows[liveIndex] = .activity(live)
    } else {
      rows.append(.thinking)
    }
  }
  return TranscriptModel(rows: rows, responding: responding)
}

/// The one-line preview of a tool call (`toolCallPreview.ts`).
public func toolCallPreview(name: String, input: JSONValue?, argumentOrder: [String]? = nil) -> String {
  func cut(_ text: String, _ limit: Int) -> String {
    text.count > limit ? String(text.prefix(limit - 1)) + "…" : text
  }
  switch name {
  case "bash": return input?["command"]?.string ?? ""
  case "webSearch": return input?["query"]?.string ?? ""
  case "webFetch": return input?["url"]?.string ?? ""
  case "loadSkill": return input?["name"]?.string ?? input?["skill"]?.string ?? ""
  case "executeTool":
    var parts: [String] = []
    if let tool = input?["tool_name"]?.string { parts.append(tool) }
    if case .object(let arguments)? = input?["arguments"] {
      // The agent's key order when known (`toolArgumentOrder`), else sorted.
      let keys = (argumentOrder ?? arguments.keys.sorted()).filter { arguments[$0] != nil }
      for key in keys.prefix(4) {
        parts.append("\(key): \(cut(arguments[key]!.jsonText, 48))")
      }
    }
    return cut(parts.joined(separator: ", "), 120)
  default:
    if case .object(let object)? = input, let first = object.values.first(where: { $0.string != nil }) {
      return cut(first.string!, 120)
    }
    return ""
  }
}

/// Verb and icon for the live status line, by tool name.
public func liveToolVerb(_ name: String) -> (verb: String, symbol: String) {
  switch name {
  case "bash": ("Running", "square-terminal")
  case "executeTool": ("Calling", "wrench")
  case "loadSkill": ("Loading", "sparkles")
  case "spawnAgent": ("Starting", "bot")
  case "webFetch": ("Reading", "globe")
  case "webSearch": ("Searching", "globe")
  default: (name, "wrench")
  }
}

/// Event-group duration: "999ms", "5.0s", "15s", "5m 15s", "2h 5m".
public func formatEventDuration(_ milliseconds: Double) -> String {
  if milliseconds < 1000 { return "\(Int(milliseconds.rounded()))ms" }
  let seconds = milliseconds / 1000
  if seconds < 10 { return String(format: "%.1fs", seconds) }
  if seconds < 60 { return "\(Int(seconds.rounded()))s" }
  return twoLargestUnits(Int(seconds))
}

/// Live "Working for" time: every unit down to seconds ("5m 15s", "1h 2m 3s").
public func formatLiveDuration(_ seconds: Int) -> String {
  let days = seconds / 86_400
  let hours = (seconds % 86_400) / 3600
  let minutes = (seconds % 3600) / 60
  let secs = seconds % 60
  if days > 0 { return "\(days)d \(hours)h" }
  if hours > 0 { return "\(hours)h \(minutes)m \(secs)s" }
  if minutes > 0 { return "\(minutes)m \(secs)s" }
  return "\(secs)s"
}

private func twoLargestUnits(_ seconds: Int) -> String {
  let units = [(86_400, "d"), (3600, "h"), (60, "m"), (1, "s")]
  var parts: [String] = []
  var rest = seconds
  for (size, label) in units where parts.count < 2 {
    let value = rest / size
    if value > 0 || !parts.isEmpty {
      if value > 0 { parts.append("\(value)\(label)") }
      rest %= size
    }
  }
  return parts.joined(separator: " ")
}

private func failureTitle(_ code: String?) -> String {
  switch code {
  case "rate_limited", "model_rate_limited": "Model rate limited"
  case "context_overflow": "Conversation too long"
  case "timeout": "Timed out"
  default: "Internal error"
  }
}
