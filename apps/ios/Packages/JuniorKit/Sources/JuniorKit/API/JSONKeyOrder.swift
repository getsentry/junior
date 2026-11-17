import Foundation

/// The key order of every tool call's `input.arguments` object in a
/// transcript response, by `toolCallId`. `JSONDecoder` drops object key
/// order; tool previews list arguments in the order the agent wrote them.
public func toolArgumentOrder(in data: Data) -> [String: [String]] {
  var reader = OrderedJSONReader(bytes: Array(data))
  guard let root = reader.value() else { return [:] }
  var orders: [String: [String]] = [:]
  func visit(_ node: OrderedJSON) {
    switch node {
    case .object(let pairs):
      if let id = pairs.first(where: { $0.0 == "toolCallId" })?.1.string,
        let input = pairs.first(where: { $0.0 == "input" })?.1,
        case .object(let inputPairs) = input,
        case .object(let arguments)? = inputPairs.first(where: { $0.0 == "arguments" })?.1
      {
        orders[id] = arguments.map(\.0)
      }
      for (_, value) in pairs { visit(value) }
    case .array(let items):
      items.forEach(visit)
    case .scalar:
      break
    }
  }
  visit(root)
  return orders
}

private indirect enum OrderedJSON {
  case object([(String, OrderedJSON)])
  case array([OrderedJSON])
  case scalar(String?)

  var string: String? {
    if case .scalar(let value) = self { return value }
    return nil
  }
}

/// A minimal JSON reader that keeps object key order. Strings keep their
/// decoded text; other scalars are not needed.
private struct OrderedJSONReader {
  let bytes: [UInt8]
  var index = 0

  init(bytes: [UInt8]) { self.bytes = bytes }

  mutating func skipSpace() {
    while index < bytes.count, [32, 9, 10, 13].contains(bytes[index]) { index += 1 }
  }

  mutating func value() -> OrderedJSON? {
    skipSpace()
    guard index < bytes.count else { return nil }
    switch bytes[index] {
    case UInt8(ascii: "{"):
      index += 1
      var pairs: [(String, OrderedJSON)] = []
      skipSpace()
      if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
        index += 1
        return .object(pairs)
      }
      while true {
        skipSpace()
        guard let key = string() else { return nil }
        skipSpace()
        guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else { return nil }
        index += 1
        guard let item = value() else { return nil }
        pairs.append((key, item))
        skipSpace()
        guard index < bytes.count else { return nil }
        if bytes[index] == UInt8(ascii: ",") {
          index += 1
        } else if bytes[index] == UInt8(ascii: "}") {
          index += 1
          return .object(pairs)
        } else {
          return nil
        }
      }
    case UInt8(ascii: "["):
      index += 1
      var items: [OrderedJSON] = []
      skipSpace()
      if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
        index += 1
        return .array(items)
      }
      while true {
        guard let item = value() else { return nil }
        items.append(item)
        skipSpace()
        guard index < bytes.count else { return nil }
        if bytes[index] == UInt8(ascii: ",") {
          index += 1
        } else if bytes[index] == UInt8(ascii: "]") {
          index += 1
          return .array(items)
        } else {
          return nil
        }
      }
    case UInt8(ascii: "\""):
      return string().map { .scalar($0) }
    default:
      // Numbers, booleans, and null: skip to the next delimiter.
      while index < bytes.count,
        ![UInt8(ascii: ","), UInt8(ascii: "}"), UInt8(ascii: "]"), 32, 9, 10, 13]
          .contains(bytes[index])
      {
        index += 1
      }
      return .scalar(nil)
    }
  }

  mutating func string() -> String? {
    guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else { return nil }
    let start = index
    index += 1
    while index < bytes.count, bytes[index] != UInt8(ascii: "\"") {
      if bytes[index] == UInt8(ascii: "\\") { index += 1 }
      index += 1
    }
    guard index < bytes.count else { return nil }
    index += 1
    let raw = bytes[(start + 1)..<(index - 1)]
    if !raw.contains(UInt8(ascii: "\\")) { return String(decoding: raw, as: UTF8.self) }
    return try? JSONDecoder().decode(String.self, from: Data(bytes[start..<index]))
  }
}
