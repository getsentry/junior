import Foundation

/// A saved instruction run later on a Schedule or an Event trigger.
public struct Automation: Codable, Hashable, Sendable, Identifiable {
  public struct Status: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let active = Self(rawValue: "active")
    public static let paused = Self(rawValue: "paused")
    public static let blocked = Self(rawValue: "blocked")
    public static let completed = Self(rawValue: "completed")
  }

  public struct Kind: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let scheduled = Self(rawValue: "scheduled")
    public static let event = Self(rawValue: "event")
  }

  public struct Destination: Codable, Hashable, Sendable {
    public var label: String?
    public var visibility: ConversationVisibility?
  }

  public struct Trigger: Codable, Hashable, Sendable {
    public var events: [String]?
    public var filters: [String]?
    public var problems: [String]?
  }

  public struct Task: Codable, Hashable, Sendable {
    public var kind: String?
    public var instruction: String?
  }

  public struct RecentRun: Codable, Hashable, Sendable {
    public var durationMs: Double?
    public var executedAt: Date?
    public var status: RunStatus
  }

  public var id: String
  public var title: String
  public var kind: Kind
  public var status: Status
  public var statusReason: String?
  public var schedule: String?
  public var timezone: String?
  public var resource: String?
  public var source: String?
  public var trigger: Trigger?
  public var destination: Destination?
  public var task: Task?
  public var createdAt: Date?
  public var createdBy: String?
  public var createdByEmail: String?
  public var ownedByViewer: Bool?
  public var nextRunAt: Date?
  public var lastRunAt: Date?
  public var lastRunStatus: RunStatus?
  public var lastConversationId: String?
  public var recentRuns: [RecentRun]?
  public var totalRuns: Int?
  public var totalCostUsd: Double?

  /// Trigger summary: the schedule, or the event resource, events, and
  /// filters joined by " · ".
  public var triggerSummary: String {
    if kind == .scheduled { return schedule ?? "Scheduled" }
    var parts: [String] = []
    if let resource, !resource.isEmpty { parts.append(resource) }
    if let events = trigger?.events, !events.isEmpty { parts.append(events.joined(separator: ", ")) }
    if let filters = trigger?.filters, !filters.isEmpty {
      parts.append("filters: " + filters.joined(separator: ", "))
    }
    return parts.isEmpty ? "Event" : parts.joined(separator: " · ")
  }

  public var hasTriggerProblems: Bool { !(trigger?.problems ?? []).isEmpty }

  /// The one problem that needs the viewer, with the dashboard's message,
  /// tone, and link label (`automationProblemSummary`).
  public func problem(clock: DisplayClock) -> (message: String, failed: Bool, action: String)? {
    let triggerProblem = kind == .event ? trigger?.problems?.first : nil
    let action = triggerProblem != nil ? "Change trigger" : lastConversationId != nil ? "Open last run" : "Open runs"
    if status == .blocked || (status == .paused && statusReason != nil) {
      return (capitalizedFirst(statusReason ?? "\(status.rawValue) until fixed"), false, action)
    }
    if let triggerProblem {
      return (capitalizedFirst(triggerProblem), false, action)
    }
    if lastRunStatus == .failed || lastRunStatus == .blocked {
      let when = lastRunAt.map { " \(clock.relative($0))" } ?? ""
      return ("Last run \(lastRunStatus!.rawValue)\(when)", lastRunStatus == .failed, action)
    }
    return nil
  }
}

public struct RunStatus: OpenEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let completed = Self(rawValue: "completed")
  public static let failed = Self(rawValue: "failed")
  public static let blocked = Self(rawValue: "blocked")
}

public struct AutomationList: Codable, Sendable {
  public var automations: [Automation]
  public var total: Int?
}

/// One Automation run, from `/api/automations/runs` or `…/{id}/executions`.
public struct AutomationRun: Codable, Hashable, Sendable, Identifiable {
  public var executionId: String
  public var automationId: String?
  public var automationTitle: String?
  public var kind: Automation.Kind?
  public var status: RunStatus
  public var executedAt: Date?
  public var durationMs: Double?
  public var totalTokens: Double?
  public var costUsd: Double?
  public var conversationId: String?
  public var title: String?
  public var error: String?

  public var id: String { executionId }
}

public struct AutomationRunList: Codable, Sendable {
  public var runs: [AutomationRun]
  public var truncated: Bool?
}

public struct AutomationExecutions: Codable, Sendable {
  public var executions: [AutomationRun]
  public var truncated: Bool?
}

/// Sections of the automations list, in order. Paused and Completed start
/// collapsed.
public func automationSections(
  _ automations: [Automation], clock: DisplayClock
) -> [(id: String, title: String, items: [Automation])] {
  let sorted = automations.sorted { lhs, rhs in
    switch (lhs.lastRunAt, rhs.lastRunAt) {
    case (let l?, let r?) where l != r: return l > r
    case (.some, nil): return true
    case (nil, .some): return false
    default:
      let l = lhs.createdAt ?? .distantPast
      let r = rhs.createdAt ?? .distantPast
      return l != r ? l > r : lhs.title < rhs.title
    }
  }
  var attention: [Automation] = []
  var active: [Automation] = []
  var paused: [Automation] = []
  var completed: [Automation] = []
  for automation in sorted {
    if automation.problem(clock: clock) != nil {
      attention.append(automation)
    } else if automation.status == .completed {
      completed.append(automation)
    } else if automation.status == .paused {
      paused.append(automation)
    } else {
      active.append(automation)
    }
  }
  return [
    ("attention", "Needs attention", attention), ("active", "Active", active),
    ("paused", "Paused", paused), ("completed", "Completed", completed),
  ].filter { !$0.2.isEmpty }
}

/// `GET /api/people/me/spend`.
public struct Spend: Codable, Sendable, Equatable {
  public var sevenDaysUsd: Double?
  public var thirtyDaysUsd: Double?
}

/// `GET /api/me`.
public struct Viewer: Codable, Sendable, Equatable {
  public struct User: Codable, Sendable, Equatable {
    public var email: String
    public var name: String?
    public var isAdmin: Bool?
  }

  public var user: User
}

/// `GET /api/config`.
public struct DashboardConfig: Codable, Sendable, Equatable {
  public var version: String?
  public var basePath: String?
}

func capitalizedFirst(_ text: String) -> String {
  guard let first = text.first else { return text }
  return first.uppercased() + text.dropFirst()
}
