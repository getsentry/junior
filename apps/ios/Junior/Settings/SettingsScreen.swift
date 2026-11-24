import JuniorKit
import SwiftUI
import UIKit

/// Settings (`SettingsPage.tsx` General): the theme, done Conversations, and
/// the Junior this app is signed in to.
struct SettingsScreen: View {
  @Environment(AppModel.self) private var app
  @Environment(WindowModel.self) private var window
  @State private var archiving = false
  @State private var archiveResult: String?
  @State private var logsResult: String?

  var body: some View {
    @Bindable var app = app
    VStack(spacing: 0) {
      AppHeader(title: app.agentName)
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          PageTitle(title: "Settings")
          ThemeRow(theme: $app.theme)
            .padding(.horizontal, 8)
            .panelCard(radius: 10)
          card(
            "Done conversations",
            description: "Archive your completed conversations now. Archive applies to everyone in them."
          ) {
            Button(archiving ? "Archiving…" : "Archive done now", action: archiveDone)
              .buttonStyle(.dashboard(.outline))
              .disabled(archiving)
            if let archiveResult {
              Text(archiveResult).type(.xs).foregroundStyle(Tokens.textMuted)
            }
          }
          card(
            "Connection",
            description: app.server.isDemo
              ? "The demo shows sample data on this device. Sign out to connect to your \(app.agentName)."
              : "Signed in through \(app.agentName)'s MCP server."
          ) {
            VStack(alignment: .leading, spacing: 4) {
              Text(app.server.isDemo ? "Demo" : app.server.baseURL.absoluteString)
                .type(.sm, .medium).foregroundStyle(Tokens.text)
              if let version = app.serverVersion {
                Text("junior version \(version)").type(.xs).foregroundStyle(Tokens.textMuted)
              }
            }
            if let error = app.shellError { InlineError(text: error.localizedDescription) }
            Button("Sign out", action: app.signOut)
              .buttonStyle(.dashboard(.outline))
              .accessibilityIdentifier("sign-out")
          }
          card("Changelog", description: "Version \(appVersion)") {
            HStack(spacing: 8) {
              if let whatsNew = app.whatsNew {
                Button(action: { open(whatsNew) }) {
                  HStack(spacing: 6) {
                    Text("What's New")
                    CountBadge(text: "New")
                  }
                }
                .buttonStyle(.dashboard(.outline))
                .accessibilityLabel("What's New, new")
                .accessibilityIdentifier("whats-new")
              }
              Button("Show changelog") { window.changelog = .full() }
                .buttonStyle(.dashboard(.outline))
                .accessibilityIdentifier("show-changelog")
            }
          }
          card("Logs", description: "Copy this launch's logs for a bug report. Message text is left out.") {
            Button("Copy logs", action: copyLogs)
              .buttonStyle(.dashboard(.outline))
            if let logsResult {
              Text(logsResult).type(.xs).foregroundStyle(Tokens.textMuted)
            }
          }
        }
        .padding(16)
        .readableWidth()
      }
    }
    .background(Tokens.bg)
    .toolbar(.hidden, for: .navigationBar)
  }

  private func archiveDone() {
    struct Archived: Decodable, Sendable { var archived: Int }
    archiving = true
    archiveResult = nil
    Task {
      defer { archiving = false }
      do {
        let result = try await app.call("archiveDoneConversations", as: Archived.self)
        archiveResult = result.archived == 1 ? "Archived 1 conversation." : "Archived \(result.archived) conversations."
        app.didWrite()
      } catch {
        archiveResult = (error as? JuniorAPIError)?.localizedDescription ?? "Could not archive."
      }
    }
  }

  private func copyLogs() {
    do {
      let lines = try recentLogLines()
      let header = [
        "Junior iOS \(appVersion)",
        "Server \(app.server.baseURL.absoluteString), junior \(app.serverVersion ?? "unknown")",
      ]
      UIPasteboard.general.string = (header + lines).joined(separator: "\n")
      logsResult = lines.count == 1 ? "Copied 1 line." : "Copied \(lines.count) lines."
    } catch {
      logsResult = "Could not read the logs. \(error.localizedDescription)"
    }
  }

  /// Show What's New and clear its badge.
  private func open(_ whatsNew: ChangelogPage) {
    window.changelog = whatsNew
    ChangelogPage.markSeen()
    app.whatsNew = nil
  }

  /// This app's version and build, such as `0.1.0 (42)`.
  private var appVersion: String {
    let info = Bundle.main.infoDictionary
    return "\(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?"))"
  }

  /// A raised card: `text-lg font-bold` title, `text-sm` description.
  private func card<Content: View>(
    _ title: String, description: String? = nil, @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      VStack(alignment: .leading, spacing: 4) {
        Text(title).type(.lg, .bold).foregroundStyle(Tokens.text).accessibilityAddTraits(.isHeader)
        if let description {
          Text(description).type(.sm).foregroundStyle(Tokens.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(20)
    .panelCard(radius: 10)
  }
}
