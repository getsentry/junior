import Foundation
import OSLog

/// The app's unified-logging channels. Stream them on a Mac with
/// `log stream --level debug --predicate 'subsystem == "io.sentry.junior"'`,
/// or in Console.app with the phone connected. Message text and response
/// bodies are private, so they show only to an attached debugger.
enum Log {
  static let subsystem = "io.sentry.junior"
  static let api = Logger(subsystem: subsystem, category: "api")
  static let oauth = Logger(subsystem: subsystem, category: "oauth")
}

/// This launch's log lines from the last `interval`, oldest first, for the
/// Settings copy action. Private values read `<private>`.
public func recentLogLines(within interval: TimeInterval = 3600) throws -> [String] {
  let store = try OSLogStore(scope: .currentProcessIdentifier)
  let start = store.position(date: Date().addingTimeInterval(-interval))
  let time = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
  return try store.getEntries(at: start, matching: NSPredicate(format: "subsystem == %@", Log.subsystem))
    .compactMap { $0 as? OSLogEntryLog }
    .map { "\($0.date.formatted(time)) \(label($0.level)) [\($0.category)] \($0.composedMessage)" }
}

private func label(_ level: OSLogEntryLog.Level) -> String {
  switch level {
  case .debug: "debug"
  case .info: "info"
  case .notice: "notice"
  case .error: "error"
  case .fault: "fault"
  default: "log"
  }
}
