import Testing

@testable import JuniorKit

@Suite struct ConversationTitleTests {
  @Test func savesOnlyAChangedTitleThatJuniorTakes() {
    #expect(renamedTitle("  Checkout fix \n", current: "Old") == "Checkout fix")
    #expect(renamedTitle(" Old ", current: "Old") == nil)
    #expect(renamedTitle("   ", current: "Old") == nil)
    #expect(renamedTitle(String(repeating: "a", count: 200), current: "Old") != nil)
    #expect(renamedTitle(String(repeating: "a", count: 201), current: "Old") == nil)
    // Junior counts UTF-16 code units, so 100 emoji fill the limit.
    #expect(renamedTitle(String(repeating: "🚀", count: 101), current: "Old") == nil)
  }

  @Test func appliesASavedTitleOnlyToItsConversation() throws {
    let state = try fixture("getConversation", as: ConversationState.self)
    let id = state.conversation.conversationId
    let renamed = state.applying(SavedTitle(conversationId: id, title: "Checkout fix"))
    #expect(renamed.conversation.title == "Checkout fix")
    let other = state.applying(SavedTitle(conversationId: "\(id)-other", title: "Checkout fix"))
    #expect(other.conversation.title == state.conversation.title)
    #expect(state.applying(nil).conversation.title == state.conversation.title)
  }
}
