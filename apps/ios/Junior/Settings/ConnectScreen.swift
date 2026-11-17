import JuniorKit
import SwiftUI

/// Shown while the dashboard rejects the app's token. The dashboard's API
/// Tokens page signs the viewer in with Google and creates a token, which the
/// viewer pastes here.
struct ConnectScreen: View {
  @Environment(AppModel.self) private var app
  @State private var serverText = ""
  @State private var token = ""
  @State private var connecting = false
  @State private var attempted = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        PageTitle(
          title: "Connect to \(app.agentName)",
          description: "The app reads your dashboard with a personal token. Create one on the web, then paste it here.")
        VStack(alignment: .leading, spacing: 20) {
          step(1, "Create a token", detail: "Sign in with Google, select Create token, then Copy token.") {
            VStack(alignment: .leading, spacing: 12) {
              TextField("https://junior.example.com", text: $serverText)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .dashboardInput()
                .accessibilityLabel("Dashboard URL")
              Button("Open API Tokens") { app.webPage = tokenPage }
                .buttonStyle(.dashboard(.outline))
                .disabled(serverURL == nil)
            }
          }
          step(2, "Paste the token", detail: nil) {
            VStack(alignment: .leading, spacing: 12) {
              HStack(spacing: 8) {
                SecureField("jr_pat_…", text: $token)
                  .textInputAutocapitalization(.never)
                  .autocorrectionDisabled()
                  .dashboardInput()
                  .accessibilityLabel("Personal token")
                  .onSubmit(connect)
                PasteButton(payloadType: String.self) { strings in
                  guard let pasted = strings.first else { return }
                  token = pasted
                  connect()
                }
                .labelStyle(.iconOnly)
                .buttonBorderShape(.roundedRectangle(radius: 6))
                .tint(Tokens.control)
              }
              Button(connecting ? "Connecting…" : "Connect", action: connect)
                .buttonStyle(.dashboard(.primary))
                .disabled(connecting || trimmedToken.isEmpty || serverURL == nil)
                .accessibilityIdentifier("connect")
              if let error = errorText { InlineError(text: error) }
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .panelCard(radius: 10)
        Text("Personal tokens are read-only. Send messages and answer questions from the web dashboard.")
          .type(.xs, lineHeight: 1.625)
          .foregroundStyle(Tokens.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(16)
    }
    .background(Tokens.bg)
    .onAppear { serverText = app.server.baseURL.absoluteString }
  }

  private var trimmedToken: String { token.trimmingCharacters(in: .whitespacesAndNewlines) }

  private var serverURL: URL? {
    let url = URL(string: serverText.trimmingCharacters(in: .whitespacesAndNewlines))
    return url?.scheme == nil ? nil : url
  }

  private var tokenPage: URL? {
    guard let serverURL else { return nil }
    var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)
    components?.path = "/settings/api-tokens"
    components?.queryItems = [URLQueryItem(name: "name", value: "\(app.agentName) for iOS")]
    return components?.url
  }

  /// Nothing to report until the viewer tries a token, except an old one that
  /// the dashboard now rejects.
  private var errorText: String? {
    guard !connecting, let error = app.shellError else { return nil }
    if error == .signedOut {
      if attempted { return "\(app.agentName) did not accept this token. Copy it again, then paste it." }
      return app.server.token == nil ? nil : "Your token expired or was revoked. Create a new one."
    }
    return error.localizedDescription
  }

  private func connect() {
    guard let serverURL, !trimmedToken.isEmpty, !connecting else { return }
    connecting = true
    attempted = true
    app.server = JuniorServer(baseURL: serverURL, token: trimmedToken)
    Task {
      await app.shellRefresh?.value
      connecting = false
    }
  }

  private func step<Content: View>(
    _ number: Int, _ title: String, detail: String?, @ViewBuilder content: () -> Content
  ) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Text("\(number)")
        .type(.xs, .semibold)
        .foregroundStyle(Tokens.text)
        .frame(width: 22, height: 22)
        .background(Tokens.fillStrong, in: Circle())
      VStack(alignment: .leading, spacing: 12) {
        VStack(alignment: .leading, spacing: 4) {
          Text(title).type(.sm, .semibold).foregroundStyle(Tokens.text).accessibilityAddTraits(.isHeader)
          if let detail {
            Text(detail).type(.xs, lineHeight: 1.625).foregroundStyle(Tokens.textMuted)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        content()
      }
    }
  }
}
