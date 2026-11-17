import Foundation

/// A home list section, keyed like the dashboard's `conversationSections.ts`.
public struct ConversationSection: Identifiable, Equatable, Sendable {
  public var id: String
  public var title: String
  public var rows: [MCPConversation]
}

/// Group home rows: Pinned, Today, Yesterday, Previous 7 days, Previous 30
/// days, then one section per month, newest activity first.
public func conversationSections(_ rows: [MCPConversation], clock: DisplayClock) -> [ConversationSection] {
  var pinned: [MCPConversation] = []
  var dated: [String: (order: Int, title: String, rows: [MCPConversation])] = [:]
  for row in rows {
    if row.pinnedAt != nil {
      pinned.append(row)
    } else {
      let bucket = dateBucket(row.lastSeenAt.date, clock: clock)
      dated[bucket.id, default: (bucket.order, bucket.title, [])].rows.append(row)
    }
  }
  var sections: [ConversationSection] = []
  if !pinned.isEmpty {
    let order = pinned.sorted { ($0.pinnedAt?.date ?? .distantPast) > ($1.pinnedAt?.date ?? .distantPast) }
    sections.append(.init(id: "pinned", title: "Pinned", rows: order))
  }
  for (id, bucket) in dated.sorted(by: { $0.value.order < $1.value.order }) {
    sections.append(.init(id: id, title: bucket.title, rows: bucket.rows.sorted(by: newerFirst)))
  }
  return sections
}

private func newerFirst(_ lhs: MCPConversation, _ rhs: MCPConversation) -> Bool {
  let l = lhs.lastSeenAt.date ?? .distantPast
  let r = rhs.lastSeenAt.date ?? .distantPast
  return l != r ? l > r : lhs.conversationId < rhs.conversationId
}

private func dateBucket(_ date: Date?, clock: DisplayClock) -> (id: String, order: Int, title: String) {
  guard let date else { return ("older", Int.max, "Older") }
  switch clock.dayAge(date) {
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
