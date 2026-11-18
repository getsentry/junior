import AuthenticationServices
import JuniorKit
import SwiftUI

/// Shown while the app has no sign-in. Sign-in runs Junior's MCP OAuth flow:
/// Google sign-in and a consent page in the browser sheet.
struct ConnectScreen: View {
  @Environment(AppModel.self) private var app
  @State private var serverText = ""
  @State private var signingIn = false
  @State private var error: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        PageTitle(
          title: "Sign in to \(app.agentName)",
          description: "Sign in with Google, then allow this app on the consent page.")
        VStack(alignment: .leading, spacing: 16) {
          VStack(alignment: .leading, spacing: 8) {
            Text("Dashboard URL").type(.sm, .semibold).foregroundStyle(Tokens.text)
            TextField("https://junior.example.com", text: $serverText)
              .keyboardType(.URL)
              .textContentType(.URL)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .dashboardInput()
              .accessibilityLabel("Dashboard URL")
              .onSubmit(signIn)
          }
          Button(signingIn ? "Signing in…" : "Sign in", action: signIn)
            .buttonStyle(.dashboard(.primary))
            .disabled(signingIn || serverURL == nil)
            .accessibilityIdentifier("sign-in")
          if let error { InlineError(text: error) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .panelCard(radius: 10)
        Text(
          "The app reads your Conversations, Review items, and Automations, and sends messages as you. Answer Review items and change Automations on the web."
        )
        .type(.xs, lineHeight: 1.625)
        .foregroundStyle(Tokens.textMuted)
        .fixedSize(horizontal: false, vertical: true)
      }
      .padding(16)
    }
    .background(Tokens.bg)
    .onAppear { serverText = app.server.baseURL.absoluteString }
  }

  private var serverURL: URL? {
    let url = URL(string: serverText.trimmingCharacters(in: .whitespacesAndNewlines))
    return url?.scheme == nil || url?.host == nil ? nil : url
  }

  private func signIn() {
    guard let serverURL, !signingIn else { return }
    signingIn = true
    error = nil
    Task {
      defer { signingIn = false }
      do {
        try await app.signIn(to: serverURL)
      } catch is CancellationError {
      } catch let failure as ASWebAuthenticationSessionError where failure.code == .canceledLogin {
      } catch {
        self.error = (error as? JuniorAPIError)?.localizedDescription ?? error.localizedDescription
      }
    }
  }
}
