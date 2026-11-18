import JuniorKit
import SwiftUI

/// Settings (`SettingsPage.tsx` General): the theme, done Conversations, and
/// the Junior this app is signed in to.
struct SettingsScreen: View {
  @Environment(AppModel.self) private var app
  @State private var archiving = false
  @State private var archiveResult: String?

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
          card("Connection", description: "Signed in through \(app.agentName)'s MCP server.") {
            VStack(alignment: .leading, spacing: 4) {
              Text(app.server.baseURL.absoluteString).type(.sm, .medium).foregroundStyle(Tokens.text)
              if let version = app.serverVersion {
                Text("junior version \(version)").type(.xs).foregroundStyle(Tokens.textMuted)
              }
            }
            if let error = app.shellError { InlineError(text: error.localizedDescription) }
            Button("Sign out", action: app.signOut)
              .buttonStyle(.dashboard(.outline))
              .accessibilityIdentifier("sign-out")
          }
        }
        .padding(16)
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
