import Foundation
import Testing

@testable import JuniorKit

@Suite struct TurnActivityTests {
  @Test func groupsActivityBetweenMessages() throws {
    let page = try fixture("listConversationMessages-activity", as: MessagePage.self)
    let items = transcriptItems(messages: page.messages, activity: page.activity ?? [])

    #expect(items.map(\.id) == ["message:0", "activity:3", "message:6", "message:7", "activity:9"])
    guard case .activity(let finished) = items[1], case .activity(let running) = items[4] else {
      Issue.record("expected activity groups")
      return
    }
    // Reasoning at 11:54:09, then a search from 11:54:10 to 11:54:14.
    #expect(finished.label == "2 events · 5.0s")
    guard case .tool(let search) = finished.steps[1] else {
      Issue.record("expected the search tool call")
      return
    }
    #expect(search.name == "webSearch")
    #expect(search.status == "completed")

    let live = running.liveStep
    #expect(live.reasoning?.hasPrefix("Read the payments-v42 pull request first") == true)
    #expect(live.tool?.name == "executeTool")
    #expect(running.startedAt == Date.junior("2026-08-07T11:54:45.000Z"))
  }

  @Test func formatsDurationsLikeTheDashboard() {
    #expect(formatDuration(999) == "999ms")
    #expect(formatDuration(5000) == "5.0s")
    #expect(formatDuration(12_400) == "12s")
    #expect(formatDuration(125_000) == "2m 5s")
    #expect(formatDuration(3_780_000) == "1h 3m")
    #expect(formatWorkingTime(0) == "0s")
    #expect(formatWorkingTime(315_000) == "5m 15s")
    #expect(formatWorkingTime(3_661_000) == "1h 1m 1s")
    #expect(formatWorkingTime(90_000_000) == "1d 1h")
  }
}
