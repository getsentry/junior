// Ported from armcknight/pippin (ChangelogParser.swift and the What's New
// rule of ChangelogPresenter.swift in Sources/PippinCore/Components),
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

/// One `## [version] date` section of a Keep a Changelog file.
public struct ChangelogEntry: Equatable, Sendable {
  /// The text in brackets, such as `0.1.0+42`, `1.0.1-RC1+42`, or `Unreleased`.
  public let version: String
  public let date: String?
  /// The Markdown under the header, without it.
  public let content: String

  public init(version: String, date: String?, content: String) {
    self.version = version
    self.date = date
    self.content = content
  }

  /// The build number after `+` in the version (`0.1.0+42` is 42), or `nil`.
  var build: Int? {
    version.firstIndex(of: "+").flatMap { Int(version[version.index(after: $0)...]) }
  }

  /// The version as people read it: `0.1.0 (42)`.
  public var title: String {
    guard let build, let plus = version.firstIndex(of: "+") else { return version }
    return "\(version[..<plus]) (\(build))"
  }
}

public enum ChangelogParser {
  /// Parse Keep a Changelog Markdown into its sections, newest first, as the
  /// file orders them. Text before the first section is left out.
  public static func parse(from markdown: String) -> [ChangelogEntry] {
    var entries: [ChangelogEntry] = []
    var currentVersion: String?
    var currentDate: String?
    var currentContent: [String] = []
    let header = try! NSRegularExpression(pattern: #"^##\s*\[([^\]]+)\](?:\s*-?\s*(.+))?"#)

    func finishEntry() {
      guard let version = currentVersion else { return }
      entries.append(
        ChangelogEntry(
          version: version, date: currentDate,
          content: currentContent.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)))
    }

    for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      guard trimmed.hasPrefix("## ") else {
        if currentVersion != nil { currentContent.append(String(line)) }
        continue
      }
      finishEntry()
      currentContent = []
      let match = header.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed))
      currentVersion = match.flatMap { Range($0.range(at: 1), in: trimmed) }.map { String(trimmed[$0]) }
      currentDate = match.flatMap { Range($0.range(at: 2), in: trimmed) }.map { String(trimmed[$0]) }
    }
    finishEntry()
    return entries
  }

  /// Entries whose build number is in `(since, upTo]`. This works for
  /// release candidates (`1.0.1-RC1+42`) and final releases (`1.0.1+44`).
  /// Entries without a `+N` build, such as `[Unreleased]`, are left out.
  public static func entriesSince(
    build since: Int, upTo current: Int, from entries: [ChangelogEntry]
  ) -> [ChangelogEntry] {
    entries.filter { entry in
      guard let build = entry.build else { return false }
      return build > since && build <= current
    }
  }

  /// What's New after an update: the entries since the build that last
  /// launched. Empty on a first launch (no last build) and when the build did
  /// not change, so a fresh install shows nothing.
  public static func whatsNew(in markdown: String, lastLaunchedBuild: Int?, currentBuild: Int) -> [ChangelogEntry] {
    guard let lastLaunchedBuild, lastLaunchedBuild != currentBuild else { return [] }
    return entriesSince(build: lastLaunchedBuild, upTo: currentBuild, from: parse(from: markdown))
  }
}
