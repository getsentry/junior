import JuniorKit
import SwiftUI

/// Settings: the Junior to connect to, the personal token, and the theme.
struct SettingsScreen: View {
  @Environment(AppModel.self) private var app
  @State private var serverText = ""
  @State private var token = ""
  @State private var saved = false
  @State private var displayName = ""
  @State private var savingName = false
  @State private var nameError: String?

  var body: some View {
    @Bindable var app = app
    VStack(spacing: 0) {
      AppHeader(title: app.agentName, leading: .back)
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          PageTitle(title: "Settings")
          card(
            "Connection",
            description: "Junior reads your dashboard with a personal token. Create one on the web in Settings › API Tokens."
          ) {
            field("Dashboard URL") {
              TextField("https://junior.example.com", text: $serverText)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            }
            field("Personal token") {
              SecureField("jr_pat_…", text: $token)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            }
            Text("Personal tokens are read-only. Send messages and answer questions from the web dashboard.")
              .font(.dashboard(.xs))
              .foregroundStyle(Tokens.textMuted)
              .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
              Button(saved ? "Saved" : "Save changes", action: save)
                .buttonStyle(.dashboard(.outline))
                .disabled(!changed)
              if app.server.token != nil {
                Button("Remove token") {
                  token = ""
                  app.server = JuniorServer(baseURL: app.server.baseURL, token: nil)
                }
                .buttonStyle(.dashboard(.ghost))
              }
            }
            if let error = app.shellError {
              InlineError(text: error.localizedDescription)
            } else if let user = app.viewer?.user {
              Text("Signed in as \(user.email)").font(.dashboard(.xs)).foregroundStyle(Tokens.textMuted)
            }
          }
          card("Profile", description: nil) {
            field("Display name") {
              TextField("", text: $displayName)
                .textContentType(.name)
            }
            Text("Your display name is shown with your conversations and activity.")
              .font(.dashboard(.sm))
              .foregroundStyle(Tokens.textMuted)
            Button(savingName ? "Saving…" : "Save changes", action: saveName)
              .buttonStyle(.dashboard(.outline))
              .disabled(savingName || displayName.trimmingCharacters(in: .whitespaces).isEmpty
                || displayName == app.viewer?.user.name)
            if let nameError { InlineError(text: nameError) }
          }
          ThemeRow(theme: $app.theme)
            .padding(.horizontal, 8)
            .panelCard(radius: 10)
          if let version = app.config?.version {
            Text("junior version \(version)").font(.dashboard(.xs)).foregroundStyle(Tokens.textMuted)
          }
        }
        .padding(16)
      }
    }
    .background(Tokens.bg)
    .toolbar(.hidden, for: .navigationBar)
    .onAppear {
      serverText = app.server.baseURL.absoluteString
      token = app.server.token ?? ""
      displayName = app.viewer?.user.name ?? ""
    }
  }

  private var changed: Bool {
    serverText != app.server.baseURL.absoluteString || token != (app.server.token ?? "")
  }

  private func saveName() {
    struct Body: Encodable { var displayName: String }
    savingName = true
    nameError = nil
    Task {
      defer { savingName = false }
      do {
        try await app.client.perform(
          "PATCH", "/api/me", body: Body(displayName: displayName.trimmingCharacters(in: .whitespaces)))
        await app.refreshShell()
      } catch {
        nameError = (error as? JuniorAPIError)?.localizedDescription ?? "Could not save your name."
      }
    }
  }

  private func save() {
    guard let url = URL(string: serverText.trimmingCharacters(in: .whitespaces)), url.scheme != nil else { return }
    app.server = JuniorServer(baseURL: url, token: token.trimmingCharacters(in: .whitespaces))
    saved = true
    Task {
      try? await Task.sleep(for: .seconds(2))
      saved = false
    }
  }

  private func card<Content: View>(
    _ title: String, description: String?, @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(.dashboard(.lg, .semibold)).foregroundStyle(Tokens.text)
        if let description {
          Text(description).font(.dashboard(.sm)).foregroundStyle(Tokens.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(20)
    .panelCard(radius: 10)
  }

  private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(label).font(.dashboard(.sm, .semibold)).foregroundStyle(Tokens.text)
      content()
        .font(.dashboard(.base))
        .foregroundStyle(Tokens.text)
        .padding(.horizontal, 12)
        .frame(height: 40)
        .background(Tokens.ink, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.borderEmphasis))
    }
  }
}
