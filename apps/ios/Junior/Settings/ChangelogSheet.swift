import JuniorKit
import SwiftUI

/// The iOS releases of the bundled root `CHANGELOG.md` to show in a sheet
/// from Settings: What's New after an update, or the full changelog.
struct ChangelogPage: Identifiable {
  let title: String
  let releases: [ChangelogRelease]
  var id: String { title }

  private static var releases: [ChangelogRelease] {
    let markdown = Bundle.main.url(forResource: "CHANGELOG", withExtension: "md")
      .flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    return ChangelogParser.parse(from: markdown ?? "")
  }

  /// Every iOS release, newest first.
  static func full() -> ChangelogPage {
    ChangelogPage(title: "Changelog", releases: releases)
  }

  private static var version: String? {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
  }

  /// The releases since the version that the person last saw, which Settings
  /// badges until they open it. A fresh install records its version and
  /// gets nothing, and Debug builds always have one version (`project.yml`),
  /// so UI tests and screenshots never get the badge.
  static func whatsNew(_ defaults: UserDefaults = .standard) -> ChangelogPage? {
    guard let version = Self.version else { return nil }
    guard let last = defaults.string(forKey: "lastSeenVersion") else {
      defaults.set(version, forKey: "lastSeenVersion")
      return nil
    }
    let releases = ChangelogParser.whatsNew(in: releases, lastSeenVersion: last, currentVersion: version)
    return releases.isEmpty ? nil : ChangelogPage(title: "What's New", releases: releases)
  }

  /// Records that the person saw What's New for this version.
  static func markSeen(_ defaults: UserDefaults = .standard) {
    if let version = Self.version { defaults.set(version, forKey: "lastSeenVersion") }
  }
}

/// A changelog page: each version over its iOS entries, by category.
struct ChangelogSheet: View {
  let page: ChangelogPage
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text(page.title)
          .type(.lg, .semibold)
          .foregroundStyle(Tokens.text)
          .accessibilityAddTraits(.isHeader)
        Spacer()
        Button { dismiss() } label: {
          Icon("x", size: 16).foregroundStyle(Tokens.textMuted).frame(width: 36, height: 36)
        }
        .buttonStyle(PressableStyle(radius: 6))
        .accessibilityLabel("Close \(page.title)")
      }
      .padding(.leading, 16)
      .padding(.trailing, 8)
      .padding(.vertical, 10)
      .hairline(.bottom, Tokens.borderSubtle)

      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          ForEach(page.releases, id: \.version) { release in
            VStack(alignment: .leading, spacing: 12) {
              Text(release.version).type(.base, .semibold).foregroundStyle(Tokens.text)
                .accessibilityAddTraits(.isHeader)
              ForEach(release.groups, id: \.title) { group in
                VStack(alignment: .leading, spacing: 4) {
                  Text(group.title).type(.xs, .semibold).foregroundStyle(Tokens.textMuted)
                  MarkdownView(group.entries.map { "- \($0)" }.joined(separator: "\n"), step: .sm)
                }
              }
            }
          }
        }
        .padding(16)
        .readableWidth()
      }
    }
    .background(Tokens.bgElevated)
  }
}
