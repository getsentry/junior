import Foundation

/// Work for a person, shown in the Inbox (Review desk).
public struct ReviewItem: Codable, Hashable, Sendable, Identifiable {
  public struct Kind: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let action = Self(rawValue: "action")
    public static let notice = Self(rawValue: "notice")
  }

  public struct Status: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let open = Self(rawValue: "open")
    public static let done = Self(rawValue: "done")
    public static let dismissed = Self(rawValue: "dismissed")
  }

  public struct Assignee: Codable, Hashable, Sendable {
    public var displayName: String?
    public var email: String?
    public var userId: String?
  }

  public struct Request: Codable, Hashable, Sendable {
    public var question: String?
    public var fields: [Field]?
  }

  public struct Field: Codable, Hashable, Sendable, Identifiable {
    public struct Kind: OpenEnum {
      public let rawValue: String
      public init(rawValue: String) { self.rawValue = rawValue }
      public static let choice = Self(rawValue: "choice")
      public static let multiChoice = Self(rawValue: "multi_choice")
      public static let text = Self(rawValue: "text")
    }

    public struct Option: Codable, Hashable, Sendable {
      public var label: String
      public var description: String?
      public var recommended: Bool?
    }

    public var id: String
    public var label: String?
    public var kind: Kind
    public var description: String?
    public var options: [Option]?
  }

  public struct Answer: Codable, Hashable, Sendable {
    public var values: [String: AnswerValue]?
    public var other: String?
  }

  public var id: String
  public var kind: Kind
  public var status: Status
  public var title: String
  public var body: String?
  public var request: Request?
  public var answer: Answer?
  public var canAct: Bool?
  public var canTake: Bool?
  public var createdAt: Date?
  public var updatedAt: Date?
  public var closedAt: Date?
  /// Who closed the item; absent when an agent closed it.
  public var closedBy: Assignee?
  public var closeReason: String?
  public var addedByConversationId: String?
  public var automationId: String?
  public var assignees: [Assignee]?
  public var assignedToEveryone: Bool?
  public var conversationIds: [String]?
  public var visibility: ConversationVisibility?

  public var isOpen: Bool { status == .open }

  /// The status words the dashboard shows for an item.
  public var statusLabel: String {
    switch status {
    case .done: return "Done"
    case .dismissed: return "Dismissed"
    default:
      if kind == .notice { return "Notice" }
      return request?.question?.isEmpty == false ? "Needs an answer" : "Waiting on you"
    }
  }

  /// One choice field with up to five options, at least one described,
  /// renders as large option buttons that answer in one press.
  public var quickChoiceField: Field? {
    guard let fields = request?.fields, fields.count == 1, let field = fields.first,
      field.kind == .choice, let options = field.options, (1...5).contains(options.count)
    else { return nil }
    return field
  }
}

/// An answer value: one string, or several for multi-choice fields.
public enum AnswerValue: Codable, Hashable, Sendable {
  case one(String)
  case many([String])

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let many = try? container.decode([String].self) {
      self = .many(many)
    } else {
      self = .one(try container.decode(String.self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .one(let value): try container.encode(value)
    case .many(let values): try container.encode(values)
    }
  }

  public var texts: [String] {
    switch self {
    case .one(let value): [value]
    case .many(let values): values
    }
  }
}

public struct ReviewItemPage: Codable, Sendable {
  public var items: [ReviewItem]
  public var nextCursor: String?
}

/// `GET /api/review-items/count`.
public struct ReviewCount: Codable, Sendable, Equatable {
  public var needsViewer: Int
}

/// Body for `POST /api/review-items/{id}/actions`.
public struct ReviewAction: Encodable, Sendable {
  public var action: String
  public var answer: ReviewItem.Answer?

  public static let dismiss = ReviewAction(action: "dismiss", answer: nil)
  public static let take = ReviewAction(action: "take", answer: nil)

  public static func submit(values: [String: [String]], other: String? = nil) -> ReviewAction {
    let trimmed = other?.trimmingCharacters(in: .whitespacesAndNewlines)
    return ReviewAction(
      action: "submit",
      answer: .init(
        values: values.mapValues { .many($0) },
        other: trimmed?.isEmpty == false ? trimmed : nil))
  }
}

/// Inbox groups, in order: Needs you (open actions) then FYI (open notices),
/// oldest first.
public func inboxGroups(_ items: [ReviewItem]) -> [(id: String, title: String, items: [ReviewItem])] {
  func sorted(_ items: [ReviewItem]) -> [ReviewItem] {
    items.sorted {
      let l = $0.createdAt ?? .distantPast
      let r = $1.createdAt ?? .distantPast
      return l != r ? l < r : $0.id < $1.id
    }
  }
  let open = items.filter(\.isOpen)
  let needsYou = sorted(open.filter { $0.kind != .notice })
  let fyi = sorted(open.filter { $0.kind == .notice })
  var groups: [(String, String, [ReviewItem])] = []
  if !needsYou.isEmpty { groups.append(("needs-you", "Needs you", needsYou)) }
  if !fyi.isEmpty { groups.append(("fyi", "FYI", fyi)) }
  return groups
}
