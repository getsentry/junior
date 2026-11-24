import Foundation
import Testing

@testable import JuniorKit

/// Tool results captured from the mock MCP server (`scripts/mock-server.mjs`),
/// which maps the dashboard's mock data with the real tools' rules.
func fixture<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
  let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
  return try JSONDecoder.junior.decode(type, from: Data(contentsOf: url))
}

@Suite struct FixtureTests {
  @Test func decodesEveryToolResult() throws {
    let list = try fixture("searchConversations", as: ConversationList.self)
    #expect(!list.conversations.isEmpty)
    // `status` reads `needs_input` for a Conversation that waits on someone,
    // but only `treeState` says whether that is you.
    #expect(list.conversations.contains { $0.status == .needsInput && $0.treeState == .done })
    #expect(list.conversations.contains { $0.status != .needsInput && $0.treeState == .needsYou })
    let state = try fixture("getConversation", as: ConversationState.self)
    #expect(state.lastReply?.isAssistant == true)
    #expect(state.messages == nil)
    let after = try fixture("getConversation-after", as: ConversationState.self)
    #expect(after.lastReply == nil)
    #expect(after.messages != nil)
    let page = try fixture("listConversationMessages", as: MessagePage.self)
    #expect(!page.messages.isEmpty)
    #expect(page.messages.map(\.seq) == page.messages.map(\.seq).sorted())
    _ = try fixture("sendMessage", as: AcceptedMessage.self)
    _ = try fixture("createConversation", as: AcceptedMessage.self)
    let items = try fixture("searchInboxItems", as: InboxItemList.self)
    #expect(items.items.allSatisfy { $0.status == "open" })
    _ = try fixture("getInboxItem", as: InboxItemResult.self)
    let automations = try fixture("searchAutomations", as: AutomationList.self)
    #expect(automations.total >= automations.automations.count)
    let automation = try fixture("getAutomation", as: AutomationDetail.self)
    #expect(!automation.automation.task.text.isEmpty)
  }

  @Test func readsConversationsFromAnOlderJunior() throws {
    // Junior 0.310 and older send their old statuses, and no `turnActive` or
    // `treeState`.
    func row(_ status: String) throws -> MCPConversation {
      let json = """
        {"conversationId":"c1","title":"T","status":"\(status)","surface":"api",\
        "startedAt":"2026-08-07T12:00:00Z","lastSeenAt":"2026-08-07T12:00:00Z"}
        """
      return try JSONDecoder.junior.decode(MCPConversation.self, from: Data(json.utf8))
    }
    #expect(try row("active").turnActive)
    #expect(try !row("completed").turnActive)
    #expect(try row("needs_input").treeState == .needsYou)
    #expect(try row("active").treeState == .working)
    #expect(try row("completed").treeState == .done)
  }

  @Test func archiveKeepsTheExactLastSeenAt() throws {
    // Archive compares `lastSeenAt` to the millisecond, so it must round-trip.
    let list = try fixture("searchConversations", as: ConversationList.self)
    let raw = try #require(list.conversations.first?.lastSeenAt.raw)
    let json = try String(
      contentsOf: #require(
        Bundle.module.url(forResource: "searchConversations", withExtension: "json", subdirectory: "Fixtures")),
      encoding: .utf8)
    #expect(json.contains("\"lastSeenAt\":\"\(raw)\"") || json.contains("\"lastSeenAt\": \"\(raw)\""))
  }

  @Test func groupsHomeSections() throws {
    let list = try fixture("searchConversations", as: ConversationList.self)
    let clock = DisplayClock(now: Date.junior("2026-08-07T12:00:00Z")!)
    let sections = conversationSections(list.conversations, clock: clock)
    #expect(sections.flatMap(\.rows).count == list.conversations.count)
    if list.conversations.contains(where: { $0.pinnedAt != nil }) { #expect(sections.first?.id == "pinned") }
    for section in sections where section.id != "pinned" {
      let dates = section.rows.compactMap(\.lastSeenAt.date)
      #expect(dates == dates.sorted(by: >))
    }
  }

  @Test func mergesPagesAndDropsReadPending() throws {
    func message(_ seq: Int, _ id: String, _ text: String) -> MCPMessage {
      MCPMessage(
        seq: seq, messageId: id, createdAt: Timestamp(raw: "2026-08-07T12:00:00Z"), role: "user", author: nil,
        text: text, attachments: nil)
    }
    let merged = mergeMessages(
      [message(1, "a", "old"), message(3, "c", "x")], [message(2, "b", "y"), message(3, "c", "new")])
    #expect(merged.map(\.seq) == [1, 2, 3])
    #expect(merged.last?.text == "new")
    let pending = [
      PendingMessage(
        messageId: "c", createdAt: Timestamp(raw: "2026-08-07T12:00:00Z"), author: nil, text: "x", attachments: nil,
        delivery: "defer"),
      PendingMessage(
        messageId: "d", createdAt: Timestamp(raw: "2026-08-07T12:00:00Z"), author: nil, text: "y", attachments: nil,
        delivery: "interrupt"),
    ]
    #expect(unreadPending(pending, transcript: merged).map(\.messageId) == ["d"])
  }
}
