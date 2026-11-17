import JuniorKit
import SwiftUI

/// Settings (`SettingsPage.tsx` General): profile, where Conversations open,
/// the theme, and the Junior this app connects to.
struct SettingsScreen: View {
  @Environment(AppModel.self) private var app
  @State private var serverText = ""
  @State private var token = ""
  @State private var saved = false
  @State private var displayName = ""
  @State private var nameEdited = false
  @State private var savingName = false
  @State private var nameError: String?

  var body: some View {
    @Bindable var app = app
    VStack(spacing: 0) {
      AppHeader(title: app.agentName)
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          PageTitle(title: "Settings")
          card("Profile") {
            field("Display name", help: "Your display name is shown with your conversations and activity.") {
              TextField("", text: $displayName)
                .textContentType(.name)
                .onChange(of: displayName) { nameEdited = displayName != (app.viewer?.user.name ?? "") }
            }
            Button(savingName ? "Saving…" : "Save changes", action: saveName)
              .buttonStyle(.dashboard(.outline))
              .disabled(savingName || !nameEdited || displayName.trimmingCharacters(in: .whitespaces).isEmpty)
            if let nameError { InlineError(text: nameError) }
          }
          card(
            "Open conversations at",
            description:
              "\(app.agentName) keeps your place in each conversation on all your devices. This choice applies to this device."
          ) {
            VStack(alignment: .leading, spacing: 12) {
              radio(
                "Where I left off", help: "Open at the first new message, below a “New” line.",
                selected: !app.openAtLatest
              ) { app.openAtLatest = false }
              radio("Latest message", help: "Always open at the newest message.", selected: app.openAtLatest) {
                app.openAtLatest = true
              }
            }
          }
          ThemeRow(theme: $app.theme)
            .padding(.horizontal, 8)
            .panelCard(radius: 10)
          card(
            "Connection",
            description:
              "The app reads your dashboard with a personal token. Create one on the web in Settings › API Tokens."
          ) {
            field("Dashboard URL") {
              TextField("https://junior.example.com", text: $serverText)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            }
            field(
              "Personal token",
              help: "Personal tokens are read-only. Send messages and answer questions from the web dashboard."
            ) {
              SecureField("jr_pat_…", text: $token)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            }
            HStack(spacing: 8) {
              Button(saved ? "Saved" : "Save changes", action: save)
                .buttonStyle(.dashboard(.outline))
                .disabled(!connectionChanged)
                .accessibilityIdentifier("save-connection")
              if app.server.token != nil {
                Button("Remove token") {
                  token = ""
                  app.server = JuniorServer(baseURL: app.server.baseURL, token: nil)
                }
                .buttonStyle(.dashboard(.ghost))
              }
            }
            if app.tokenSaveFailed {
              InlineError(text: "Could not save the token in the Keychain. It works until the app quits.")
            }
            if let error = app.shellError {
              InlineError(text: error.localizedDescription)
            } else if let user = app.viewer?.user {
              Text("Signed in as \(user.email)").type(.xs).foregroundStyle(Tokens.textMuted)
            }
          }
          if let version = app.config?.version {
            Text("junior version \(version)").type(.xs).foregroundStyle(Tokens.textMuted)
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
    }
    // `/api/me` can land after the page opens; fill the name until it is edited.
    .onChange(of: app.viewer?.user.name, initial: true) { _, name in
      if !nameEdited { displayName = name ?? "" }
    }
  }

  private var connectionChanged: Bool {
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
          "PATCH", "/api/me", body: Body(displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines)))
        await app.refreshShell()
        nameEdited = false
      } catch {
        nameError = (error as? JuniorAPIError)?.localizedDescription ?? "Could not save your name."
      }
    }
  }

  private func save() {
    guard let url = URL(string: serverText.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme != nil
    else { return }
    // A pasted token often ends in a newline; the server rejects any space.
    app.server = JuniorServer(baseURL: url, token: token.trimmingCharacters(in: .whitespacesAndNewlines))
    saved = true
    Task {
      try? await Task.sleep(for: .seconds(2))
      saved = false
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

  private func field<Content: View>(
    _ label: String, help: String? = nil, @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(label).type(.sm, .semibold).foregroundStyle(Tokens.text)
      content().dashboardInput()
      if let help {
        Text(help).type(.xs, lineHeight: 1.625).foregroundStyle(Tokens.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func radio(_ label: String, help: String, selected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: 12) {
        Circle()
          .strokeBorder(selected ? Tokens.accent : Tokens.borderInteractive, lineWidth: 1)
          .background(Circle().fill(selected ? Tokens.accent : .clear))
          .overlay { if selected { Circle().fill(Tokens.textInverse).frame(width: 6, height: 6) } }
          .frame(width: 16, height: 16)
          .padding(.top, 2)
        VStack(alignment: .leading, spacing: 2) {
          Text(label).type(.sm, .medium).foregroundStyle(Tokens.text)
          // `text-xs/4`: a 16pt line.
          Text(help).type(.xs, lineHeight: 16.0 / 13).foregroundStyle(Tokens.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? [.isSelected] : [])
  }
}
