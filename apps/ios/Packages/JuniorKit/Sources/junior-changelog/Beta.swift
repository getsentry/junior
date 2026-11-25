import Foundation
import JuniorKit

/// TestFlight's limit for a build's "What to Test" text.
let whatToTestLimit = 4000

/// The latest server release among `tags`: the highest `X.Y.Z` tag. The app
/// and the server share this version.
func latestRelease(tags: [String]) -> String? {
  tags.compactMap { tag in SemanticVersion(tag).map { (tag, $0) } }.max { $0.1 < $1.1 }?.0
}

/// The commit of the beta that wrote `notes`: their last line, `Commit abc1234`.
func betaCommit(notes: String) -> String? {
  guard let last = notes.split(whereSeparator: \.isNewline).last?.trimmingCharacters(in: .whitespaces),
    last.hasPrefix("Commit ")
  else { return nil }
  let commit = last.dropFirst("Commit ".count)
  return commit.count >= 7 && commit.allSatisfy(\.isHexDigit) ? String(commit) : nil
}

/// A squash-merge subject with the `ios` scope, such as
/// `feat(ios): Rename a conversation (#4044)`. Squash-merge subjects are PR
/// titles, which Craft also reads.
struct IOSCommit: Equatable {
  let subject: String
  /// Craft's changelog category, such as `New Features ✨`.
  let category: String
  /// The subject after `type(scope): `.
  let title: String

  init?(subject: String) {
    let pattern = #/^(?<type>\w+)\((?<scopes>[^)]*)\)(?<breaking>!?): (?<title>.+)$/#
    guard let match = subject.wholeMatch(of: pattern),
      match.scopes.split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces).lowercased() })
        .contains("ios")
    else { return nil }
    self.subject = subject
    self.title = String(match.title)
    self.category =
      if !match.breaking.isEmpty { "Breaking Changes 🛠" } else {
        switch match.type {
        case "feat": "New Features ✨"
        case "fix": "Bug Fixes 🐛"
        case "docs": "Documentation 📚"
        default: "Internal Changes 🔧"
        }
      }
  }
}

/// The "What to Test" notes: one subject a line, as `git log` orders them,
/// then `Commit <commit>`, so the next beta starts where this one stopped.
/// Subjects that do not fit TestFlight's limit become one "And N more." line.
func betaNotes(commits: [IOSCommit], commit: String) -> String {
  let lines = commits.isEmpty ? ["No iOS changes since the last beta."] : commits.map(\.subject)
  func notes(keeping count: Int) -> String {
    let more = lines.count - count
    return (lines.prefix(count) + (more > 0 ? ["And \(more) more."] : [])).joined(separator: "\n")
      + "\n\nCommit \(commit)"
  }
  var count = lines.count
  while count > 0, notes(keeping: count).utf16.count > whatToTestLimit { count -= 1 }
  return notes(keeping: count)
}

/// `markdown` with an `## Upcoming` section on top in Craft's format, so the
/// app shows this beta's entries. Unchanged without entries.
func changelog(_ markdown: String, upcoming commits: [IOSCommit]) -> String {
  guard !commits.isEmpty else { return markdown }
  var categories: [String] = []
  for commit in commits where !categories.contains(commit.category) { categories.append(commit.category) }
  var section = "## \(ChangelogParser.upcoming)\n"
  for category in categories {
    section += "\n### \(category)\n\n"
    for commit in commits where commit.category == category { section += "- (ios) \(linked(commit.title))\n" }
  }
  guard let first = markdown.range(of: "\n## ") else { return markdown + "\n" + section }
  let release = markdown.index(after: first.lowerBound)
  return String(markdown[..<release]) + section + "\n" + markdown[release...]
}

/// The title with its `(#4044)` as a pull request link, as Craft writes it.
private func linked(_ title: String) -> String {
  title.replacing(#/ \(#(\d+)\)$/#) { " ([#\($0.1)](https://github.com/getsentry/junior/pull/\($0.1)))" }
}
