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
}
