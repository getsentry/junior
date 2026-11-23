// The section parser and the What's New rule are ported from armcknight/pippin
// (ChangelogParser.swift and ChangelogPresenter.swift in
// Sources/PippinCore/Components),
// https://github.com/armcknight/pippin, under the MIT License:
//
// Copyright (c) 2016 Andrew McKnight
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import Foundation

/// The iOS entries of one `## version` section of the root `CHANGELOG.md`,
/// which Craft writes at each server release.
public struct ChangelogRelease: Equatable, Sendable {
  /// The header text, such as `0.313.0`.
  public let version: String
  public let groups: [ChangelogGroup]

  public init(version: String, groups: [ChangelogGroup]) {
    self.version = version
    self.groups = groups
  }
}

/// The iOS entries under one `### category` header, such as `New Features ✨`.
public struct ChangelogGroup: Equatable, Sendable {
  public let title: String
  /// Markdown, one line for each entry.
  public let entries: [String]

  public init(title: String, entries: [String]) {
    self.title = title
    self.entries = entries
  }
}

public enum ChangelogParser {
  /// Parse Craft's changelog into its releases, newest first, as the file
  /// orders them, with only the iOS entries: the ones under `#### Ios`, and
  /// the ones with the `(ios)` scope. Releases without iOS entries, and the
  /// categories that app users do not see (Internal Changes, Documentation),
  /// are left out.
  public static func parse(from markdown: String) -> [ChangelogRelease] {
    var releases: [ChangelogRelease] = []
    var version: String?
    var groups: [ChangelogGroup] = []
    var category: String?
    var scope: String?
    var entries: [String] = []

    func finishGroup() {
      if let category, !entries.isEmpty { groups.append(ChangelogGroup(title: category, entries: entries)) }
      entries = []
    }
    func finishRelease() {
      finishGroup()
      if let version, !groups.isEmpty { releases.append(ChangelogRelease(version: version, groups: groups)) }
      groups = []
    }

    for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if let header = trimmed.headerText("## ") {
        finishRelease()
        version = header
        category = nil
        scope = nil
      } else if let header = trimmed.headerText("### ") {
        finishGroup()
        category = hiddenCategories.contains { header.hasPrefix($0) } ? nil : header
        scope = nil
      } else if let header = trimmed.headerText("#### ") {
        scope = header
      } else if line.hasPrefix("- "), category != nil, let entry = iosEntry(String(line.dropFirst(2)), scope: scope) {
        entries.append(entry)
      }
    }
    finishRelease()
    return releases
  }

  private static let hiddenCategories = ["Internal Changes", "Documentation"]

  /// The entry as app users read it, or `nil` for an entry of another area.
  /// It drops the `(ios)` scope and the authors, and keeps the pull request
  /// link: `Add Log out ([#3888](…))`.
  static func iosEntry(_ text: String, scope: String?) -> String? {
    var text = text
    if let prefix = text.range(of: "(ios) ", options: [.anchored, .caseInsensitive]) {
      text.removeSubrange(prefix)
    } else if scope?.lowercased() != "ios" {
      return nil
    }
    guard let by = text.range(of: " by @"),
      let link = text.range(of: #" in (\[#\d+\]\([^)]+\))$"#, options: .regularExpression)
    else { return text }
    return "\(text[..<by.lowerBound]) (\(text[link].dropFirst(4)))"
  }

  /// Releases whose version is in `(since, upTo]`.
  public static func releases(
    since: String, upTo current: String, from releases: [ChangelogRelease]
  ) -> [ChangelogRelease] {
    releases.filter { release in
      guard let version = SemanticVersion(release.version), let since = SemanticVersion(since),
        let current = SemanticVersion(current)
      else { return false }
      return since < version && version <= current
    }
  }

  /// What's New after an update: the releases since the version that the
  /// person last saw. Empty on a first launch (no last version) and when the
  /// version did not change, so a fresh install shows nothing.
  public static func whatsNew(
    in releases: [ChangelogRelease], lastSeenVersion: String?, currentVersion: String
  ) -> [ChangelogRelease] {
    guard let lastSeenVersion, lastSeenVersion != currentVersion else { return [] }
    return self.releases(since: lastSeenVersion, upTo: currentVersion, from: releases)
  }
}

/// `MAJOR.MINOR.PATCH`, ordered by number.
struct SemanticVersion: Comparable {
  let parts: [Int]

  init?(_ text: String) {
    let parts = text.split(separator: ".").map { Int($0) }
    guard parts.count == 3, !parts.contains(nil) else { return nil }
    self.parts = parts.compactMap { $0 }
  }

  static func < (lhs: Self, rhs: Self) -> Bool { lhs.parts.lexicographicallyPrecedes(rhs.parts) }
}

extension String {
  /// The text after a Markdown header marker, such as `## `, or `nil`.
  fileprivate func headerText(_ marker: String) -> String? {
    hasPrefix(marker) ? String(dropFirst(marker.count)).trimmingCharacters(in: .whitespaces) : nil
  }
}
