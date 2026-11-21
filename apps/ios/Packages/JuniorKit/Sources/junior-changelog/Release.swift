// The idea of versioning `[Unreleased]` and keeping each build's notes outside
// the repo comes from `changetag` and `migrate-changelog` in armcknight/tools
// (https://github.com/armcknight/tools, Apache License 2.0). This code is new.

import Foundation
import JuniorKit

/// TestFlight's limit for a build's "What to Test" text.
let whatToTestLimit = 4000

/// An earlier TestFlight build and its "What to Test" notes. TestFlight is the
/// record of what shipped, because a beta commits nothing.
struct ShippedBuild: Decodable {
  var version: String
  var build: Int
  /// `YYYY-MM-DD`.
  var date: String
  var notes: String
}

/// A beta: its marketing version, its "What to Test" notes, and the
/// CHANGELOG.md to bundle in it.
struct Release {
  var version: String
  var notes: String
  var changelog: String
}

enum ReleaseError: Error, CustomStringConvertible {
  case badVersion(String)
  case notesTooLong(Int)

  var description: String {
    switch self {
    case .badVersion(let version): "\(version) is not an X.Y.Z version."
    case .notesTooLong(let count):
      "The new [Unreleased] entries are \(count) characters. TestFlight accepts \(whatToTestLimit). "
        + "Shorten the entries that did not ship yet."
    }
  }
}

/// Version build `build` from `[Unreleased]`. Entries that an earlier build's
/// notes hold are left out. The bump comes from the categories of the
/// remaining entries: `Removed` or `Breaking` is major (minor below 1.0),
/// `Fixed` or `Security` alone is patch, and any other category is minor.
/// With no new entries the version stays the same and the notes are empty.
/// The changelog gets the new section and the earlier sections, rebuilt from
/// `shipped`, so What's New in the app finds them.
func prepareRelease(
  changelog: String, shipped: [ShippedBuild], build: Int, baseVersion: String, date: String
) throws -> Release {
  let entries = ChangelogParser.parse(from: changelog)
  let unreleased = entries.first { $0.version.lowercased() == "unreleased" }?.content ?? ""
  let shippedItems = Set(shipped.flatMap { changelogCategories(in: $0.notes).flatMap(\.items).map(itemKey) })
  let newCategories = changelogCategories(in: unreleased).compactMap { category in
    var category = category
    category.items.removeAll { shippedItems.contains(itemKey($0)) }
    return category.items.isEmpty ? nil : category
  }
  let notes = newCategories.map(\.markdown).joined(separator: "\n\n")
  guard notes.utf16.count <= whatToTestLimit else { throw ReleaseError.notesTooLong(notes.utf16.count) }

  let latest = shipped.max { $0.build < $1.build }
  let bump = newCategories.map { versionBump(for: $0.name) }.max()
  let version =
    switch (latest, bump) {
    case (let latest?, let bump?): try nextVersion(latest.version, bump)
    case (let latest?, nil): latest.version
    case (nil, _): baseVersion
    }

  var sections = shipped.filter { !$0.notes.isEmpty }
    .map { (build: $0.build, markdown: "## [\($0.version)+\($0.build)] \($0.date)\n\n\($0.notes)") }
  // Versioned sections in the repo's file stay unless TestFlight has the build.
  let shippedBuilds = Set(shipped.map(\.build))
  for entry in entries {
    guard let entryBuild = entry.build, !shippedBuilds.contains(entryBuild) else { continue }
    let header = ["## [\(entry.version)]", entry.date].compactMap { $0 }.joined(separator: " ")
    sections.append((build: entryBuild, markdown: "\(header)\n\n\(entry.content)"))
  }
  if !notes.isEmpty { sections.append((build: build, markdown: "## [\(version)+\(build)] \(date)\n\n\(notes)")) }
  sections.sort { $0.build > $1.build }

  let preamble = changelog.components(separatedBy: "\n").prefix { !$0.hasPrefix("## ") }
    .joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
  let bundled = ([preamble] + sections.map(\.markdown)).filter { !$0.isEmpty }.joined(separator: "\n\n") + "\n"
  return Release(version: version, notes: notes, changelog: bundled)
}

enum VersionBump: Comparable { case patch, minor, major }

func versionBump(for category: String?) -> VersionBump {
  let name = category?.lowercased() ?? ""
  if name.hasPrefix("removed") || name.hasPrefix("breaking") { return .major }
  if name.hasPrefix("fixed") || name.hasPrefix("security") { return .patch }
  return .minor
}

/// The next `X.Y.Z`. Below 1.0, a major bump is a minor bump, as in SemVer
/// 0.x, where the minor version marks breaking changes.
func nextVersion(_ version: String, _ bump: VersionBump) throws -> String {
  let parts = version.split(separator: ".").map { Int($0) }
  guard (2...3).contains(parts.count), let major = parts[0], let minor = parts[1],
    let patch = parts.count == 3 ? parts[2] : 0
  else { throw ReleaseError.badVersion(version) }
  switch bump {
  case .major where major > 0: return "\(major + 1).0.0"
  case .major, .minor: return "\(major).\(minor + 1).0"
  case .patch: return "\(major).\(minor).\(patch + 1)"
  }
}

/// One `### Category` of a section and its entries. An entry is a bullet, or
/// a paragraph, with its lines as written.
struct ChangelogCategory {
  var name: String?
  var items: [[String]]

  /// Each entry on one line, since TestFlight shows the notes as plain text.
  /// Nested bullets keep their own lines.
  var markdown: String {
    let body = items.map { item in
      item.dropFirst().reduce(item[0]) { text, line in
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return ["- ", "* ", "+ "].contains { trimmed.hasPrefix($0) } ? "\(text)\n\(line)" : "\(text) \(trimmed)"
      }
    }
    return ([name.map { "### \($0)\n" }].compactMap { $0 } + body).joined(separator: "\n")
  }
}

/// The categories of a section's Markdown, in order. Text before the first
/// `###` heading has no category.
func changelogCategories(in content: String) -> [ChangelogCategory] {
  var categories: [ChangelogCategory] = []
  var afterBlank = true
  for line in content.components(separatedBy: "\n") {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.hasPrefix("### ") {
      categories.append(ChangelogCategory(name: String(trimmed.dropFirst(4)), items: []))
      afterBlank = true
      continue
    }
    if trimmed.isEmpty {
      afterBlank = true
      continue
    }
    if categories.isEmpty { categories.append(ChangelogCategory(name: nil, items: [])) }
    let isBullet = ["- ", "* ", "+ "].contains { line.hasPrefix($0) }
    let continues = line.first?.isWhitespace == true || !afterBlank
    if isBullet || !continues || categories[categories.count - 1].items.isEmpty {
      categories[categories.count - 1].items.append([line])
    } else {
      categories[categories.count - 1].items[categories[categories.count - 1].items.count - 1].append(line)
    }
    afterBlank = false
  }
  return categories.filter { !$0.items.isEmpty }
}

/// An entry's text with its line breaks and runs of spaces as one space, so a
/// rewrapped entry still matches the one that shipped.
private func itemKey(_ item: [String]) -> String {
  item.joined(separator: " ").split(whereSeparator: \.isWhitespace).joined(separator: " ")
}
