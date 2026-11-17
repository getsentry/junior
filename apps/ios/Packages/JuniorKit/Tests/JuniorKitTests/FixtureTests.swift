import Foundation
import Testing

@testable import JuniorKit

/// Fixtures are real responses from the dashboard's mock reporting
/// (`apps/ios/scripts/mock-server.mts`), pinned to 2026-08-07T12:00:00Z.
func fixture<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
  let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")!
  return try JSONDecoder.junior.decode(T.self, from: Data(contentsOf: url))
}

let mockNow = Date.junior("2026-08-07T12:00:00.000Z")!
let pacific = TimeZone(identifier: "America/Los_Angeles")!

@Suite struct FixtureTests {
  @Test func decodesEveryEndpoint() throws {
    _ = try fixture("me", as: Viewer.self)
    _ = try fixture("config", as: DashboardConfig.self)
    _ = try fixture("spend", as: Spend.self)
    _ = try fixture("review-count", as: ReviewCount.self)
    _ = try fixture("versions", as: DataVersions.self)
    _ = try fixture("review-item", as: ReviewItem.self)
    let closed = try fixture("review-item-closed", as: ReviewItem.self)
    #expect(closed.status == .done && closed.closedBy?.displayName == "Dashboard User")
    _ = try fixture("automation", as: Automation.self)
    _ = try fixture("automation-executions", as: AutomationExecutions.self)
    let feed = try fixture("conversations", as: ConversationFeed.self)
    #expect(feed.conversations.count == 50)
    #expect(feed.nextCursor != nil)
    let runs = try fixture("automation-runs", as: AutomationRunList.self)
    #expect(!runs.runs.isEmpty)
  }

  @Test func groupsHomeSections() throws {
    let feed = try fixture("conversations", as: ConversationFeed.self)
    let waiting = try fixture("waiting", as: WaitingConversations.self)
    let map = Dictionary(uniqueKeysWithValues: waiting.conversations.map { ($0.conversationId, $0.waitingSince) })
    let sections = conversationSections(
      feed.conversations, waiting: map, clock: DisplayClock(now: mockNow, timeZone: pacific))
    #expect(sections.map(\.title).prefix(2) == ["Needs you", "Today"])
    #expect(sections[0].rows.map(\.title) == ["Plan the billing migration", "Roll out payments-v42"])
    #expect(sections[1].rows.first?.title == "Investigate checkout latency")
  }

  @Test func formatsTimesLikeTheDashboard() {
    let clock = DisplayClock(now: mockNow, timeZone: pacific)
    #expect(clock.activityDay(Date.junior("2026-08-07T11:20:00.000Z")!) == "4:20 AM")
    #expect(clock.activityDay(Date.junior("2026-08-06T11:20:00.000Z")!) == "Yesterday")
    #expect(clock.activityDay(Date.junior("2026-08-03T11:20:00.000Z")!) == "Mon")
    #expect(clock.activityDay(Date.junior("2026-07-01T11:20:00.000Z")!) == "Jul 1")
    #expect(clock.activityDay(Date.junior("2025-07-01T11:20:00.000Z")!) == "Jul 1, 2025")
    #expect(clock.relative(Date.junior("2026-08-07T11:18:00.000Z")!) == "42 minutes ago")
    #expect(clock.relative(Date.junior("2026-08-10T16:00:00.000Z")!) == "in 3 days")
    #expect(clock.dateTimeWithZone(Date.junior("2026-08-07T11:00:00.000Z")!) == "Aug 7, 2026, 4:00 AM PDT")
  }

  @Test func buildsTranscriptRows() throws {
    let detail = try fixture("conversation-detail", as: ConversationDetail.self)
    let model = buildTranscript(
      events: detail.events, status: detail.status, fallbackAuthor: detail.actorIdentity)
    #expect(model.responding)
    let kinds = model.rows.map { row -> String in
      switch row {
      case .message(let m): if case .agent = m.speaker { "agent" } else { "person" }
      case .activity(let a): a.isLive ? "live" : "activity"
      case .failure: "failure"
      case .thread: "thread"
      case .delivered: "delivered"
      case .thinking: "thinking"
      }
    }
    #expect(kinds == ["person", "activity", "agent", "person", "live"])
    guard case .activity(let first) = model.rows[1], case .message(let reply) = model.rows[2],
      case .activity(let live) = model.rows[4]
    else {
      Issue.record("unexpected rows")
      return
    }
    #expect(first.summary == "2 events · 5.0s")
    #expect(reply.recalledMemories == 1)
    #expect(live.latestReasoning?.hasPrefix("Read the payments-v42 pull request") == true)
    #expect(liveToolVerb("executeTool").verb == "Calling")
    #expect(detail.mailbox?.messages?.count == 7)
  }

  @Test func groupsInbox() throws {
    let page = try fixture("review-items", as: ReviewItemPage.self)
    let groups = inboxGroups(page.items)
    #expect(groups.first?.title == "Needs you")
    #expect(groups.first?.items.first?.title == "Pick the billing migration window")
  }

  @Test func sectionsAutomations() throws {
    let list = try fixture("automations", as: AutomationList.self)
    let sections = automationSections(list.automations, clock: DisplayClock(now: mockNow, timeZone: pacific))
    #expect(sections.map(\.title) == ["Needs attention", "Active"])
    #expect(sections[0].items.first?.title == "Incident change alerts")
    #expect(sections[1].items.map(\.title) == ["Weekly project summary", "Closed issue summary"])
  }

  @Test func readOnlyTokenWrites() {
    #expect(JuniorClient.error(status: 401, method: "POST", hasToken: true, data: Data()) == .readOnlyToken)
    #expect(JuniorClient.error(status: 401, method: "GET", hasToken: true, data: Data()) == .signedOut)
  }

  @Test func encodesReviewAnswer() throws {
    let body = try JSONEncoder().encode(ReviewAction.submit(values: ["window": ["Sunday 02:00 UTC"]]))
    let json = try JSONSerialization.jsonObject(with: body) as! [String: Any]
    #expect(json["action"] as? String == "submit")
    let answer = json["answer"] as! [String: Any]
    #expect((answer["values"] as! [String: [String]])["window"] == ["Sunday 02:00 UTC"])
  }
}

@Suite struct ToolPreviewTests {
  @Test func keepsArgumentOrder() throws {
    let url = Bundle.module.url(forResource: "conversation-detail", withExtension: "json", subdirectory: "Fixtures")!
    let data = try Data(contentsOf: url)
    let detail = try JSONDecoder.junior.decode(ConversationDetail.self, from: data)
    let model = buildTranscript(
      events: detail.events, status: detail.status, fallbackAuthor: nil, argumentOrder: toolArgumentOrder(in: data))
    guard case .activity(let live) = model.rows.last, case .tool(_, let preview, _)? = live.runningTool?.kind else {
      Issue.record("expected a running tool")
      return
    }
    #expect(preview == #"github_getPullRequest, repo: "getsentry/payments", number: 42"#)
  }
}

@Suite struct TranscriptRegressionTests {
  private func events(_ json: String) throws -> [TranscriptEvent] {
    try JSONDecoder.junior.decode([TranscriptEvent].self, from: Data(json.utf8))
  }

  /// Only the first event of a call carries its input (server `events.ts`).
  @Test func keepsToolPreviewAfterUpdate() throws {
    let model = buildTranscript(
      events: try events(
        """
        [{"seq":1,"createdAt":"2026-08-07T11:00:00.000Z","data":{"type":"tool_calls","calls":[{"toolCallId":"t1","name":"bash","status":"running","input":{"command":"ls -la"}}]}},
         {"seq":2,"createdAt":"2026-08-07T11:00:03.000Z","data":{"type":"tool_calls","calls":[{"toolCallId":"t1","name":"bash","status":"completed"}]}}]
        """), status: .completed, fallbackAuthor: nil)
    guard case .activity(let activity) = model.rows.first,
      case .tool(_, let preview, let state) = activity.entries.first?.kind
    else {
      Issue.record("expected one tool row")
      return
    }
    #expect(preview == "ls -la")
    #expect(state == .completed)
    #expect(activity.summary == "1 event · 3.0s")
  }

  /// A child's start and end events make one card, and its spawn call hides.
  @Test func mergesSubagentEvents() throws {
    let model = buildTranscript(
      events: try events(
        """
        [{"seq":1,"createdAt":"2026-08-07T11:00:00.000Z","data":{"type":"tool_calls","calls":[{"toolCallId":"spawn","name":"spawnAgent","status":"running"}]}},
         {"seq":2,"createdAt":"2026-08-07T11:00:01.000Z","data":{"type":"subagent","childConversationId":"c1","childKind":"thread","status":"running","title":"Check","startedSeq":2,"parentToolCallId":"spawn"}},
         {"seq":5,"createdAt":"2026-08-07T11:01:00.000Z","data":{"type":"subagent","childConversationId":"c1","childKind":"thread","status":"completed","title":"Check","startedSeq":2,"parentToolCallId":"spawn"}}]
        """), status: .completed, fallbackAuthor: nil)
    #expect(model.rows.count == 1)
    guard case .thread(let thread) = model.rows.first else {
      Issue.record("expected one thread card")
      return
    }
    #expect(thread.status == "completed")
  }

  @Test func namesFailuresLikeTheWeb() throws {
    let model = buildTranscript(
      events: try events(
        """
        [{"seq":1,"createdAt":"2026-08-07T11:00:00.000Z","data":{"type":"turn_lifecycle","turnId":"t","state":"failed","failureCode":"model_execution_failed","failureReason":"rate_limit"}}]
        """), status: .failed, fallbackAuthor: nil)
    guard case .failure(let failure) = model.rows.first else {
      Issue.record("expected a failure row")
      return
    }
    #expect(failure.title == "Model rate limited")
  }
}
