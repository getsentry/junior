import Foundation
import Testing

@testable import JuniorKit

@Suite struct TurnActivityTests {
  @Test func groupsActivityBetweenMessages() throws {
    // The dashboard detail of the mock checkout Conversation, and its
    // messages as MCP lists them.
    let page = try fixture("conversationDetail-activity", as: ReportActivityPage.self)
    let messages = try JSONDecoder.junior.decode(
      [MCPMessage].self,
      from: Data(
        #"""
        [{"seq":0,"messageId":"m0","createdAt":"2026-08-07T11:54:00.000Z","role":"user","text":"Find it"},
         {"seq":6,"messageId":"m6","createdAt":"2026-08-07T11:54:22.000Z","role":"assistant","text":"Found it"},
         {"seq":7,"messageId":"m7","createdAt":"2026-08-07T11:54:40.000Z","role":"user","text":"Check it"}]
        """#.utf8))
    let items = transcriptItems(messages: messages, activity: page.activity)

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

  @Test func readsReasoningAndToolCallsInEventOrder() throws {
    let page = try fixture("conversationDetail-activity", as: ReportActivityPage.self)
    #expect(page.activity.map(\.seq) == [3, 4, 5, 9])
    let running = try #require(page.activity.last)
    guard case .reasoning(let text) = running.parts.first, case .toolCall(let call) = running.parts.last else {
      Issue.record("expected reasoning, then the tool call")
      return
    }
    #expect(text.hasPrefix("Read the payments-v42 pull request first"))
    #expect(call.name == "executeTool" && call.status == "running")
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
