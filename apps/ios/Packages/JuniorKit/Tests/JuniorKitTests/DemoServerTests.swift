import Foundation
import Testing

@testable import JuniorKit

/// A clock that a test moves forward.
final class ManualClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value = Date()
  var now: Date { lock.withLock { value } }
  func advance(_ seconds: TimeInterval) { lock.withLock { value += seconds } }
}

/// The demo through `MCPClient`, so every result decodes as the app reads it.
@Suite struct DemoServerTests {
  private func demo(_ clock: ManualClock = ManualClock()) -> MCPClient {
    let credentials = OAuthCredentials(
      server: .demo, clientID: "demo", tokenEndpoint: JuniorServer.demo.page("/api/mcp/oauth/token")!,
      accessToken: "demo", refreshToken: nil, expiresAt: .distantFuture, scope: nil)
    let server = DemoServer(now: { clock.now })
    return MCPClient(server: .demo, store: MemoryStore(credentials), transport: server.transport)
  }

  private func id(_ value: String) -> [String: JSONValue] { ["conversationId": .string(value)] }

  @Test func answersEveryScreen() async throws {
    let clock = ManualClock()
    let client = demo(clock)
    _ = try await client.serverInfo()
    let active = try await client.call("searchConversations", as: ConversationList.self)
    let archived = try await client.call("searchConversations", ["status": "archived"], as: ConversationList.self)
    #expect(!archived.conversations.isEmpty && archived.conversations.allSatisfy { $0.archivedAt != nil })
    // The mock data's times move to the demo's start.
    let lastSeen = try #require(active.conversations.first?.lastSeenAt.date)
    #expect(abs(lastSeen.timeIntervalSince(clock.now)) < 3600)
    #expect(active.conversations.contains { $0.treeState == .needsYou })
    // A search reads summaries as well as titles.
    let found = try await client.call("searchConversations", ["q": "serializer"], as: ConversationList.self)
    #expect(!found.conversations.isEmpty)
    #expect(found.conversations.allSatisfy { $0.summary?.contains("serializer") == true })
    for row in active.conversations + archived.conversations {
      let state = try await client.call("getConversation", id(row.conversationId), as: ConversationState.self)
      #expect(state.conversation.conversationId == row.conversationId)
      _ = try await client.call(
        "listConversationMessages", id(row.conversationId).merging(["limit": 30]) { a, _ in a }, as: MessagePage.self)
    }
    let items = try await client.call("searchInboxItems", ["limit": 50], as: InboxItemList.self)
    #expect(!items.items.isEmpty)
    let replyNotice = try #require(items.items.first { $0.id == "qa-reply-dashboard-qa" })
    #expect(replyNotice.canAct && !replyNotice.needsViewer)
    let todo = try #require(items.items.first { $0.id == "qa-todo-preview-deploy" })
    #expect(todo.question == nil && todo.needsViewer)
    for item in items.items {
      _ = try await client.call("getInboxItem", ["id": .string(item.id)], as: InboxItemResult.self)
      for conversationId in item.conversationIds {
        _ = try await client.call("getConversation", id(conversationId), as: ConversationState.self)
      }
    }
    let automations = try await client.call("searchAutomations", as: AutomationList.self)
    #expect(!automations.automations.isEmpty)
    for automation in automations.automations {
      let detail = try await client.call("getAutomation", ["id": .string(automation.id)], as: AutomationDetail.self)
      for conversationId in detail.runs.compactMap(\.conversationId) {
        _ = try await client.call("getConversation", id(conversationId), as: ConversationState.self)
      }
    }
  }

  @Test func repliesToASentMessage() async throws {
    let clock = ManualClock()
    let client = demo(clock)
    let list = try await client.call("searchConversations", as: ConversationList.self)
    let row = try #require(list.conversations.first { !$0.turnActive })
    let sent = try await client.call(
      "sendMessage", id(row.conversationId).merging(["message": "Hello", "idempotencyKey": "k1"]) { a, _ in a },
      as: AcceptedMessage.self)
    let working = try await client.call(
      "getConversation", id(row.conversationId).merging(["after": .string(sent.cursor)]) { a, _ in a },
      as: ConversationState.self)
    #expect(working.conversation.turnActive && working.conversation.treeState == .working)
    #expect(working.messages?.map(\.text) == ["Hello"])

    let retry = try await client.call(
      "sendMessage", id(row.conversationId).merging(["message": "Hello", "idempotencyKey": "k1"]) { a, _ in a },
      as: AcceptedMessage.self)
    #expect(retry.status == "duplicate")

    clock.advance(DemoServer.replyDelay)
    let done = try await client.call(
      "getConversation", id(row.conversationId).merging(["after": .string(working.cursor)]) { a, _ in a },
      as: ConversationState.self)
    #expect(!done.conversation.turnActive && done.conversation.treeState == .done)
    #expect(done.messages?.map(\.isAssistant) == [true])
  }

  @Test func createsAConversation() async throws {
    let client = demo()
    let accepted = try await client.call(
      "createConversation", ["message": "Check the deploy", "visibility": "private"], as: AcceptedMessage.self)
    let list = try await client.call("searchConversations", as: ConversationList.self)
    #expect(list.conversations.first?.conversationId == accepted.conversationId)
    #expect(list.conversations.first?.title == "Check the deploy")
  }

  @Test func archivesAndPins() async throws {
    let client = demo()
    let list = try await client.call("searchConversations", as: ConversationList.self)
    let row = try #require(list.conversations.first { !$0.turnActive })
    await #expect(throws: JuniorAPIError.tool("Conversation received new activity.")) {
      try await client.call(
        "archiveConversation", id(row.conversationId).merging(["lastSeenAt": "2020-01-01T00:00:00Z"]) { a, _ in a },
        as: ConversationList.self)
    }
    struct Archived: Decodable, Sendable { var archivedAt: Timestamp? }
    _ = try await client.call(
      "archiveConversation", id(row.conversationId).merging(["lastSeenAt": .string(row.lastSeenAt.raw)]) { a, _ in a },
      as: Archived.self)
    let archived = try await client.call("searchConversations", ["status": "archived"], as: ConversationList.self)
    #expect(archived.conversations.contains { $0.conversationId == row.conversationId })

    struct Pinned: Decodable, Sendable { var pinnedAt: Timestamp? }
    let pinned = try await client.call("pinConversation", id(row.conversationId), as: Pinned.self)
    #expect(pinned.pinnedAt != nil)
    let restored = try await client.call("searchConversations", as: ConversationList.self)
    #expect(restored.conversations.contains { $0.conversationId == row.conversationId && $0.pinnedAt != nil })
  }

  @Test func renames() async throws {
    let client = demo()
    let list = try await client.call("searchConversations", as: ConversationList.self)
    let row = try #require(list.conversations.first)
    struct Renamed: Decodable, Sendable { var title: String }
    let renamed = try await client.call(
      "renameConversation", id(row.conversationId).merging(["title": "  Checkout fix  "]) { a, _ in a },
      as: Renamed.self)
    #expect(renamed.title == "Checkout fix")
    let state = try await client.call("getConversation", id(row.conversationId), as: ConversationState.self)
    #expect(state.conversation.title == "Checkout fix")
    await #expect(throws: JuniorAPIError.tool("The title must have 1 to 200 characters.")) {
      try await client.call(
        "renameConversation", id(row.conversationId).merging(["title": " "]) { a, _ in a }, as: Renamed.self)
    }
  }
}
