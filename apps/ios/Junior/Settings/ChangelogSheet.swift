import JuniorKit
import SwiftUI

/// Sections of the bundled `CHANGELOG.md` to show in a sheet: What's New
/// after an update, or the full changelog from Settings.
struct ChangelogPage: Identifiable {
  let title: String
  let entries: [ChangelogEntry]
  var id: String { title }

  private static var markdown: String {
    Bundle.main.url(forResource: "CHANGELOG", withExtension: "md")
      .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
  }

  /// Every section, newest first.
  static func full() -> ChangelogPage {
    ChangelogPage(title: "Changelog", entries: ChangelogParser.parse(from: markdown))
  }

  /// The sections since the build that last launched, once per update. It
  /// records this build as the last one. A fresh install shows nothing, and
  /// Debug builds are always build 1 (`project.yml`), so UI tests and
  /// screenshots never get this sheet.
  static func whatsNew(_ defaults: UserDefaults = .standard) -> ChangelogPage? {
    guard let build = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String).flatMap(Int.init)
    else { return nil }
    let last = defaults.object(forKey: "lastLaunchedBuild") as? Int
    defaults.set(build, forKey: "lastLaunchedBuild")
    let entries = ChangelogParser.whatsNew(in: markdown, lastLaunchedBuild: last, currentBuild: build)
    return entries.isEmpty ? nil : ChangelogPage(title: "What's New", entries: entries)
  }
}

/// A changelog page: each version and date over its Markdown notes.
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
          ForEach(page.entries, id: \.version) { entry in
            VStack(alignment: .leading, spacing: 8) {
              HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(entry.title).type(.base, .semibold).foregroundStyle(Tokens.text)
                  .accessibilityAddTraits(.isHeader)
                if let date = entry.date {
                  Text(date).type(.xs).foregroundStyle(Tokens.textMuted)
                }
              }
              MarkdownView(entry.content, step: .sm)
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
