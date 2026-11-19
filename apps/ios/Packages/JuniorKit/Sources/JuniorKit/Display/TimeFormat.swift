import Foundation

/// Calendar and clock for display rules. The dashboard counts calendar days in
/// the viewer's time zone and always formats in en-US.
public struct DisplayClock: Sendable {
  public var now: Date
  public var timeZone: TimeZone

  public init(now: Date = Date(), timeZone: TimeZone = .current) {
    self.now = now
    self.timeZone = timeZone
  }

  var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    calendar.locale = Locale(identifier: "en_US")
    return calendar
  }

  /// Whole calendar days from `date` to now; negative for future dates.
  public func dayAge(_ date: Date) -> Int {
    let calendar = calendar
    let from = calendar.startOfDay(for: date)
    let to = calendar.startOfDay(for: now)
    return calendar.dateComponents([.day], from: from, to: to).day ?? 0
  }

  func format(_ date: Date, _ template: String) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US")
    formatter.timeZone = timeZone
    formatter.dateFormat = template
    // Intl output uses a narrow no-break space before AM/PM; keep plain spaces.
    return formatter.string(from: date).replacingOccurrences(of: "\u{202F}", with: " ")
  }

  /// Home row time: "4:20 AM" today, "Yesterday", "Mon" this week, then
  /// "Aug 7" ("Aug 7, 2025" in another year). Mirrors `formatActivityDay`.
  public func activityDay(_ date: Date) -> String {
    let age = dayAge(date)
    if age <= 0 { return clockTime(date) }
    if age == 1 { return "Yesterday" }
    if age < 7 { return format(date, "EEE") }
    return sameYear(date) ? format(date, "MMM d") : format(date, "MMM d, yyyy")
  }

  /// Message time: "11:54 AM" today, "Aug 7, 11:54 AM" this year, then
  /// "Aug 7, 2025, 11:54 AM".
  public func messageTime(_ date: Date) -> String {
    if dayAge(date) == 0 { return clockTime(date) }
    return sameYear(date) ? format(date, "MMM d, h:mm a") : format(date, "MMM d, yyyy, h:mm a")
  }

  /// "4:54 AM".
  public func clockTime(_ date: Date) -> String {
    format(date, "h:mm a")
  }

  /// "Aug 7, 2026, 4:00 AM PDT".
  public func dateTimeWithZone(_ date: Date) -> String {
    format(date, "MMM d, yyyy, h:mm a zzz")
  }

  /// "Aug 10, 2026, 9:00 AM PDT" style without the zone when `zone` is false.
  public func dateTime(_ date: Date, zone: Bool = false) -> String {
    format(date, zone ? "MMM d, yyyy, h:mm a zzz" : "MMM d, yyyy, h:mm a")
  }

  func sameYear(_ date: Date) -> Bool {
    calendar.component(.year, from: date) == calendar.component(.year, from: now)
  }

  /// Relative age: "just now", "42 minutes ago", "3 days ago", "in 3 days".
  public func relative(_ date: Date) -> String {
    let seconds = now.timeIntervalSince(date)
    let future = seconds < 0
    let magnitude = abs(seconds)
    let units: [(Double, String)] = [
      (60, "second"), (3600, "minute"), (86_400, "hour"), (604_800, "day"), (2_629_800, "week"),
      (31_557_600, "month"), (.infinity, "year"),
    ]
    let divisors: [Double] = [1, 60, 3600, 86_400, 604_800, 2_629_800, 31_557_600]
    if magnitude < 45 { return future ? "in a few seconds" : "just now" }
    for (index, unit) in units.enumerated() where magnitude < unit.0 {
      let value = Int((magnitude / divisors[index]).rounded())
      // `Intl.RelativeTimeFormat` with `numeric: "auto"` names ±1 day.
      if unit.1 == "day", value == 1 { return future ? "tomorrow" : "yesterday" }
      let label = "\(value) \(unit.1)\(value == 1 ? "" : "s")"
      return future ? "in \(label)" : "\(label) ago"
    }
    return ""
  }
}

/// Durations as the dashboard shows them: "5.0s", "42s", "5m 15s", "1h 2m".
public func formatDuration(milliseconds: Double, precise: Bool = false) -> String {
  let seconds = milliseconds / 1000
  if seconds < 60 {
    return precise ? String(format: "%.1fs", seconds) : "\(Int(seconds.rounded()))s"
  }
  let total = Int(seconds)
  if total < 3600 { return "\(total / 60)m \(total % 60)s" }
  return "\(total / 3600)h \((total % 3600) / 60)m"
}

/// Model spend: "$0.42", "$0.04+" for a lower bound, "<$0.01" for small sums.
public func formatCost(_ usd: Double, lowerBound: Bool = false) -> String {
  if usd > 0, usd < 0.01 { return "<$0.01" }
  return String(format: "$%.2f", usd) + (lowerBound ? "+" : "")
}

/// Compact counts: "480", "1.2k", "164k", "1.9M".
public func formatCompactCount(_ value: Double) -> String {
  switch value {
  case ..<1000: return "\(Int(value))"
  case ..<10_000: return trimZero(String(format: "%.1f", value / 1000)) + "k"
  case ..<1_000_000: return "\(Int((value / 1000).rounded()))k"
  default: return trimZero(String(format: "%.1f", value / 1_000_000)) + "M"
  }
}

private func trimZero(_ text: String) -> String {
  text.hasSuffix(".0") ? String(text.dropLast(2)) : text
}
