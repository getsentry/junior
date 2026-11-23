import Foundation

/// A tool call, merged from its start and end events.
public struct ActivityTool: Hashable, Sendable {
  public var id: String
  public var name: String
  /// `running`, `completed`, or `error`.
  public var status: String
  public var startedAt: Date?
  public var endedAt: Date?
}

/// One row of a Turn's activity: reasoning or a tool call.
public enum ActivityStep: Hashable, Sendable, Identifiable {
  case reasoning(id: String, text: String, at: Date?)
  case tool(ActivityTool)

  public var id: String {
    switch self {
    case .reasoning(let id, _, _): id
    case .tool(let tool): "tool:\(tool.id)"
    }
  }

  var startedAt: Date? {
    switch self {
    case .reasoning(_, _, let at): at
    case .tool(let tool): tool.startedAt
    }
  }

  var endedAt: Date? {
    switch self {
    case .reasoning(_, _, let at): at
    case .tool(let tool): tool.endedAt ?? tool.startedAt
    }
  }
}

/// The activity between two messages, shown as one collapsed row
/// (`TranscriptActivityGroup.tsx`).
public struct ActivityGroup: Hashable, Sendable, Identifiable {
  /// The seq of its first event.
  public var id: Int
  public var steps: [ActivityStep]

  /// The earliest start of a step.
  public var startedAt: Date? { steps.compactMap(\.startedAt).min() }

  /// From the earliest start to the latest end (`activityGroupDurationMs`).
  public var durationMs: Int? {
    guard let start = startedAt, let end = steps.compactMap(\.endedAt).max(), end >= start else { return nil }
    return Int((end.timeIntervalSince(start) * 1000).rounded(.down))
  }

  /// "2 events · 5.0s" (`activityGroupLabel`).
  public var label: String {
    let count = steps.count == 1 ? "1 event" : "\(steps.count) events"
    guard let duration = durationMs, duration > 0 else { return count }
    return "\(count) · \(formatDuration(duration))"
  }

  /// What a running Turn shows while its activity is closed: the latest
  /// reasoning, and a tool call that runs after it (`liveActivityStep`).
  public var liveStep: (reasoning: String?, tool: ActivityTool?) {
    var tool: ActivityTool?
    for step in steps.reversed() {
      switch step {
      case .tool(let call):
        if call.status == "running", tool == nil { tool = call }
      case .reasoning(_, let text, _):
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return (trimmed, tool) }
      }
    }
    return (nil, tool)
  }
}

/// One transcript row: a message, or the activity before the next message.
public enum TranscriptItem: Hashable, Sendable, Identifiable {
  case message(MCPMessage)
  case activity(ActivityGroup)

  public var id: String {
    switch self {
    case .message(let message): "message:\(message.seq)"
    case .activity(let group): "activity:\(group.id)"
    }
  }
}

/// Interleave messages and activity by seq. Activity between two messages
/// forms one group. A tool call's end event updates the row where it started.
public func transcriptItems(messages: [MCPMessage], activity: [MCPActivity]) -> [TranscriptItem] {
  enum Entry {
    case message(MCPMessage)
    case activity(MCPActivity)
  }
  var entries: [(seq: Int, entry: Entry)] = messages.map { ($0.seq, .message($0)) }
  entries += activity.map { ($0.seq, .activity($0)) }
  entries.sort { $0.seq < $1.seq }

  var items: [TranscriptItem] = []
  var group: ActivityGroup?
  // Where each tool call shows: a closed group's item index, or nil for the
  // open group, and the step index.
  var tools: [String: (item: Int?, step: Int)] = [:]

  func update(_ call: MCPActivity.ToolCall, at event: Date?, in steps: inout [ActivityStep], _ index: Int) {
    guard case .tool(var tool) = steps[index] else { return }
    tool.name = call.name
    tool.status = call.status
    if tool.startedAt == nil { tool.startedAt = call.startedAt?.date }
    if call.status != "running" { tool.endedAt = event }
    steps[index] = .tool(tool)
  }

  for (_, entry) in entries {
    switch entry {
    case .message(let message):
      if let open = group {
        for (id, place) in tools where place.item == nil { tools[id] = (items.count, place.step) }
        items.append(.activity(open))
        group = nil
      }
      items.append(.message(message))
    case .activity(let event):
      let at = event.createdAt.date
      var open = group ?? ActivityGroup(id: event.seq, steps: [])
      for (index, part) in event.parts.enumerated() {
        switch part {
        case .reasoning(let text):
          open.steps.append(.reasoning(id: "\(event.seq):\(index)", text: text, at: at))
        case .toolCall(let call):
          if let place = tools[call.toolCallId] {
            if let item = place.item, case .activity(var closed) = items[item] {
              update(call, at: at, in: &closed.steps, place.step)
              items[item] = .activity(closed)
            } else if place.item == nil {
              update(call, at: at, in: &open.steps, place.step)
            }
            continue
          }
          tools[call.toolCallId] = (nil, open.steps.count)
          open.steps.append(
            .tool(
              ActivityTool(
                id: call.toolCallId, name: call.name, status: call.status,
                startedAt: call.startedAt?.date ?? at,
                endedAt: call.status == "running" ? nil : at)))
        case .unknown:
          continue
        }
      }
      group = open.steps.isEmpty ? nil : open
    }
  }
  if let open = group { items.append(.activity(open)) }
  return items
}

/// Milliseconds as compact units, like the dashboard's `formatDuration`:
/// `999ms`, `5.0s`, `12s`, then the two largest non-zero units, `2m 5s`.
public func formatDuration(_ ms: Int) -> String {
  let ms = max(0, ms)
  if ms < 1000 { return "\(ms)ms" }
  if ms < 60_000 {
    let seconds = Double(ms) / 1000
    if seconds < 10 { return String(format: "%.1fs", (seconds * 10).rounded() / 10) }
    return "\(Int(seconds.rounded()))s"
  }
  var remaining = ms
  var parts: [String] = []
  for (unit, size) in [("d", 86_400_000), ("h", 3_600_000), ("m", 60_000), ("s", 1000)] {
    let count = remaining / size
    if count == 0 { continue }
    parts.append("\(count)\(unit)")
    remaining %= size
    if parts.count == 2 { break }
  }
  return parts.joined(separator: " ")
}

/// How long a running Turn has worked, like the dashboard's ticking
/// "Working for" time: every unit shows, even at zero; over a day, days and
/// hours.
public func formatWorkingTime(_ ms: Int) -> String {
  let seconds = max(0, ms / 1000)
  let minutes = seconds / 60
  let hours = minutes / 60
  if hours >= 24 { return "\(hours / 24)d \(hours % 24)h" }
  if hours > 0 { return "\(hours)h \(minutes % 60)m \(seconds % 60)s" }
  if minutes > 0 { return "\(minutes)m \(seconds % 60)s" }
  return "\(seconds)s"
}
