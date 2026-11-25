import Foundation
import Testing

@testable import JuniorKit

struct InboxItemCountTests {
  @Test func readsTheBadgeCount() throws {
    let json = #"{"codeChanges":5,"decisions":11,"needsViewer":17,"snoozed":0,"todos":1}"#
    #expect(try JSONDecoder.junior.decode(InboxItemCount.self, from: Data(json.utf8)).needsViewer == 17)
  }
}
