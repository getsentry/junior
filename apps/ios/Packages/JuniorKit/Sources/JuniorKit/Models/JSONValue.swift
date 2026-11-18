import Foundation

/// Any JSON value, for tool inputs and other open-ended payloads.
public enum JSONValue: Codable, Hashable, Sendable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case object([String: JSONValue])
  case array([JSONValue])
  case null

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .bool(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .null: try container.encodeNil()
    }
  }

  public subscript(key: String) -> JSONValue? {
    if case .object(let object) = self { return object[key] }
    return nil
  }

  public var string: String? {
    if case .string(let value) = self { return value }
    return nil
  }

  public var array: [JSONValue]? {
    if case .array(let value) = self { return value }
    return nil
  }

  /// Compact JSON text, with strings quoted as `JSON.stringify` does.
  public var jsonText: String {
    switch self {
    case .string(let value):
      let encoder = JSONEncoder()
      encoder.outputFormatting = .withoutEscapingSlashes
      let data = try? encoder.encode(value)
      return data.flatMap { String(data: $0, encoding: .utf8) } ?? "\"\(value)\""
    case .number(let value):
      return value == value.rounded() && abs(value) < 1e15 ? String(Int(value)) : String(value)
    case .bool(let value): return value ? "true" : "false"
    case .null: return "null"
    case .array, .object:
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
      return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
  }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral {
  public init(stringLiteral value: String) { self = .string(value) }
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(integerLiteral value: Int) { self = .number(Double(value)) }
}
