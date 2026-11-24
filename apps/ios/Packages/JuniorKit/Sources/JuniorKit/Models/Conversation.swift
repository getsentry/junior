import Foundation

/// A string enum that keeps unknown server values instead of failing to
/// decode, so a new status from a newer Junior never breaks the app.
public protocol OpenEnum: RawRepresentable, Codable, Hashable, Sendable where RawValue == String {
  init(rawValue: String)
}

extension OpenEnum {
  public init(from decoder: Decoder) throws {
    self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}

public struct ConversationStatus: OpenEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let needsInput = Self(rawValue: "needs_input")
  public static let working = Self(rawValue: "working")
  public static let done = Self(rawValue: "done")
}

/// What a Conversation and its child Conversations need from the viewer
/// (`conversationTreeStateSchema`), the "Viewer state" in `TERMINOLOGY.md`.
public struct ConversationTreeState: OpenEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let needsYou = Self(rawValue: "needs_you")
  public static let working = Self(rawValue: "working")
  public static let done = Self(rawValue: "done")
}

public struct ConversationVisibility: OpenEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let `public` = Self(rawValue: "public")
  public static let `private` = Self(rawValue: "private")
}

/// A timestamp that keeps the server's exact text. Writes such as archive
/// compare it to the millisecond, and a round trip through `Date` loses that.
public struct Timestamp: Codable, Hashable, Sendable {
  public let raw: String

  public init(raw: String) { self.raw = raw }

  public init(from decoder: Decoder) throws {
    raw = try decoder.singleValueContainer().decode(String.self)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(raw)
  }

  public var date: Date? { Date.junior(raw) }
}
