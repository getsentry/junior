import Foundation

/// The demo's mock data (`demo-data.json`), with every time moved by one
/// amount so that the data's `now` becomes the time the demo starts.
struct DemoData {
  var conversations: [DemoConversation]
  var reviewItems: [JSONObject]
  var automations: [JSONObject]

  static func load(movedTo now: Date) -> DemoData {
    guard let url = Bundle.module.url(forResource: "demo-data", withExtension: "json"),
      let data = try? Data(contentsOf: url),
      let root = try? JSONDecoder().decode(JSONValue.self, from: data),
      let dataNow = root["now"]?.string.flatMap(Date.junior)
    else { preconditionFailure("JuniorKit is missing demo-data.json; run scripts/export-demo-data.mjs.") }
    let moved = move(root, by: now.timeIntervalSince(dataNow))
    return DemoData(
      conversations: (moved["conversations"]?.array ?? []).compactMap(\.object).map { entry in
        DemoConversation(
          summary: entry["conversation"]?.object ?? [:], brief: entry["brief"],
          messages: (entry["messages"]?.array ?? []).compactMap(\.object),
          pending: entry["pendingMessages"]?.array ?? [], authorization: entry["authorization"],
          listed: entry["listed"]?.bool ?? true)
      },
      reviewItems: (moved["reviewItems"]?.array ?? []).compactMap(\.object),
      automations: (moved["automations"]?.array ?? []).compactMap(\.object))
  }

  /// Move every time (a `…At` field) by `interval`.
  private static func move(_ value: JSONValue, by interval: TimeInterval) -> JSONValue {
    switch value {
    case .object(let object):
      var moved = object
      for (key, field) in object {
        if key.hasSuffix("At"), let date = field.string.flatMap(Date.junior) {
          moved[key] = .string(demoTimestamp(date.addingTimeInterval(interval)))
        } else {
          moved[key] = move(field, by: interval)
        }
      }
      return .object(moved)
    case .array(let array): return .array(array.map { move($0, by: interval) })
    default: return value
    }
  }
}
