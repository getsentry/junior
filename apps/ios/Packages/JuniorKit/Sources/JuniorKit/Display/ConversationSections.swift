import Foundation

/// A home list section, keyed like the dashboard's
/// `conversationSections.ts` so saved collapse state carries over.
public struct ConversationSection: Identifiable, Equatable, Sendable {
  public var id: String
  public var title: String
  public var rows: [ConversationSummary]
}

/// Group home rows: Pinned, Needs you, Today, Yesterday, Previous 7 days,
/// Previous 30 days, then one section per month, newest first.
public func conversationSections(
  _ rows: [ConversationSummary],
  waiting: [String: Date?],
  clock: DisplayClock
) -> [ConversationSection] {
  var pinned: [ConversationSummary] = []
  var needsYou: [ConversationSummary] = []
  var dated: [String: (order: Int, title: String, rows: [ConversationSummary])] = [:]

  for row in rows {
    if row.pinnedAt != nil {
      pinned.append(row)
    } else if waiting.keys.contains(row.conversationId) || row.awaitingAuthorization == true {
      needsYou.append(row)
    } else {
      let bucket = dateBucket(row.activityAt, clock: clock)
      dated[bucket.id, default: (bucket.order, bucket.title, [])].rows.append(row)
    }
  }

  pinned.sort { lhs, rhs in
    switch (lhs.pinPosition, rhs.pinPosition) {
    case (nil, nil):
      let l = lhs.pinnedAt ?? .distantPast
      let r = rhs.pinnedAt ?? .distantPast
      return l != r ? l > r : lhs.conversationId < rhs.conversationId
    case (nil, _): return true
    case (_, nil): return false
    case (let l?, let r?): return l < r
    }
  }
  needsYou.sort { lhs, rhs in
    let l = waiting[lhs.conversationId] ?? nil
    let r = waiting[rhs.conversationId] ?? nil
    switch (l, r) {
    case (let l?, let r?): return l < r
    case (.some, nil): return true
    case (nil, .some): return false
    case (nil, nil): return newerFirst(lhs, rhs)
    }
  }

  var sections: [ConversationSection] = []
  if !pinned.isEmpty { sections.append(.init(id: "pinned", title: "Pinned", rows: pinned)) }
  if !needsYou.isEmpty { sections.append(.init(id: "needs-you", title: "Needs you", rows: needsYou)) }
  for (id, bucket) in dated.sorted(by: { $0.value.order < $1.value.order }) {
    sections.append(.init(id: id, title: bucket.title, rows: bucket.rows.sorted(by: newerFirst)))
  }
  return sections
}

private func newerFirst(_ lhs: ConversationSummary, _ rhs: ConversationSummary) -> Bool {
  switch (lhs.activityAt, rhs.activityAt) {
  case (let l?, let r?): return l > r
  case (.some, nil): return true
  case (nil, .some): return false
  case (nil, nil): return lhs.conversationId < rhs.conversationId
  }
}

private func dateBucket(_ date: Date?, clock: DisplayClock) -> (id: String, order: Int, title: String) {
  guard let date else { return ("older", Int.max, "Older") }
  let age = clock.dayAge(date)
  switch age {
  case ...0: return ("today", 0, "Today")
  case 1: return ("yesterday", 1, "Yesterday")
  case 2...7: return ("previous-7-days", 2, "Previous 7 days")
  case 8...30: return ("previous-30-days", 3, "Previous 30 days")
  default:
    let calendar = clock.calendar
    let year = calendar.component(.year, from: date)
    let month = calendar.component(.month, from: date)
    let name = clock.format(date, "MMMM")
    let title = year == calendar.component(.year, from: clock.now) ? name : "\(name) \(year)"
    // Newer months sort first after the fixed sections.
    return ("month-\(year)-\(month)", 4 + (9999 - year) * 12 + (12 - month), title)
  }
}

/// Label for a Slack Location, as `format.ts` names channels.
public func slackLocationLabel(channel: String?, name: String?, redacted: Bool?) -> String? {
  guard let channel, !channel.isEmpty else { return nil }
  if redacted == true, let name, !name.isEmpty { return name }
  switch channel.first {
  case "D": return "Direct Message"
  case "C": return name.map { $0.isEmpty ? "Public Channel" : "#\($0)" } ?? "Public Channel"
  case "G": return name?.hasPrefix("mpdm-") == true ? "Group DM" : "Private Channel"
  default: return name.map { "#\($0)" }
  }
}
