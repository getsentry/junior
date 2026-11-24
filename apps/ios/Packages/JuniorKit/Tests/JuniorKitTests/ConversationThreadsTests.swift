import Foundation
import Testing

@testable import JuniorKit

/// A Conversation row whose newest activity is `minute` past 12:00.
private func row(_ id: String, minute: Int, _ threads: [[String: Any]] = []) -> [String: Any] {
  let time = String(format: "2026-08-07T12:%02d:00.000Z", minute)
  var json: [String: Any] = [
    "conversationId": id, "title": id, "status": "done", "turnActive": false, "surface": "api",
    "startedAt": time, "lastSeenAt": time,
  ]
  if !threads.isEmpty { json["threads"] = threads }
  return json
}

private func decode(_ rows: [[String: Any]]) throws -> [MCPConversation] {
  let data = try JSONSerialization.data(withJSONObject: rows)
  return try JSONDecoder.junior.decode([MCPConversation].self, from: data)
}

@Suite struct ConversationThreadsTests {
  @Test func nestsFixtureThreadsDepthFirst() throws {
    let list = try fixture("searchConversations", as: ConversationList.self)
    let root = try #require(list.conversations.first { $0.conversationId == "internal:dashboard-qa" })
    let shown = threadRows(root.threads, expanded: false)
    let thread = "junior:internal:dashboard-qa:thread"
    #expect(shown.rows.map(\.id) == [thread, "\(thread):nested"])
    #expect(shown.rows.map(\.depth) == [0, 1])
    #expect(!shown.collapsible)
    #expect(threadRows(nil, expanded: false) == ThreadRows(rows: [], collapsible: false, hiddenCount: 0))
  }

  @Test func collapsesToTheNewestDirectThreads() throws {
    // Server order, with `b` holding a nested Thread and the oldest activity.
    let threads = try decode([
      row("a", minute: 5), row("b", minute: 1, [row("b1", minute: 9)]), row("c", minute: 4),
      row("d", minute: 3), row("e", minute: 2),
    ])

    let collapsed = threadRows(threads, expanded: false)
    #expect(collapsed.rows.map(\.id) == ["a", "c", "d"])
    #expect(collapsed.collapsible)
    #expect(collapsed.hiddenCount == 3)

    // The open Thread's direct ancestor shows too, with its nested rows.
    let open = threadRows(threads, expanded: false, selectedId: "b1")
    #expect(open.rows.map(\.id) == ["a", "b", "b1", "c", "d"])
    #expect(open.rows.map(\.depth) == [0, 0, 1, 0, 0])
    #expect(open.hiddenCount == 1)

    let expanded = threadRows(threads, expanded: true)
    #expect(expanded.rows.map(\.id) == ["a", "b", "b1", "c", "d", "e"])
    #expect(expanded.collapsible)
    #expect(expanded.hiddenCount == 0)
  }

  @Test func capsTheIndent() throws {
    let threads = try decode([row("a", minute: 1, [row("b", minute: 1, [row("c", minute: 1, [row("d", minute: 1)])])])])
    let rows = threadRows(threads, expanded: false).rows
    #expect(rows.map(\.depth) == [0, 1, 2, 3])
    #expect(rows.map(\.indent) == [0, 1, 2, 2])
  }
}
