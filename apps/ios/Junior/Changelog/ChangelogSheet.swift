import JuniorKit
import SwiftUI

/// The iOS releases of the bundled root `CHANGELOG.md`, newest first, and
/// whether some are newer than the version that the person last saw.
enum BundledChangelog {
  static var releases: [ChangelogRelease] {
    let markdown = Bundle.main.url(forResource: "CHANGELOG", withExtension: "md")
      .flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    return ChangelogParser.parse(from: markdown ?? "")
  }

  /// True on a fresh install, and after an update that added releases, until
  /// the person opens the changelog.
  static func hasUnseen(_ defaults: UserDefaults = .standard) -> Bool {
    let version = AppBuild.current.changelogVersion
    guard let last = defaults.string(forKey: "lastSeenVersion") else { return !releases.isEmpty }
    let unseen = ChangelogParser.whatsNew(in: releases, lastSeenVersion: last, currentVersion: version)
    return !unseen.isEmpty
  }

  /// Records that the person saw the changelog of this version.
  static func markSeen(_ defaults: UserDefaults = .standard) {
    defaults.set(AppBuild.current.changelogVersion, forKey: "lastSeenVersion")
  }
}

/// The changelog: each version over its iOS entries, by category.
struct ChangelogSheet: View {
  let close: () -> Void
  private let releases = BundledChangelog.releases

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Changelog")
          .type(.lg, .semibold)
          .foregroundStyle(Tokens.text)
          .accessibilityAddTraits(.isHeader)
        Spacer()
        Button(action: close) {
          Icon("x", size: 16).foregroundStyle(Tokens.textMuted).frame(width: 36, height: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(radius: 6))
        .accessibilityLabel("Close Changelog")
      }
      .padding(.leading, 16)
      .padding(.trailing, 8)
      .padding(.vertical, 10)
      .hairline(.bottom, Tokens.borderSubtle)

      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          ForEach(releases, id: \.version) { release in
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
