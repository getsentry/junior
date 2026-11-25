import AuthenticationServices
import JuniorKit
import UIKit

/// Sign in to Junior's MCP server in the system browser sheet. The same
/// consent gives the dashboard API session. Junior knows this app, and
/// redirects to the app's `junior-ios` URL scheme; the sheet gives that
/// redirect back only to this app.
@MainActor
final class BrowserSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
  private static let callbackScheme = "junior-ios"
  private var session: ASWebAuthenticationSession?

  func run(_ oauth: OAuthClient, session: SessionSignInClient) async throws -> (OAuthCredentials, SessionCredentials) {
    let signIn = try await oauth.begin(redirectURI: "\(Self.callbackScheme)://oauth/callback", withSession: true)
    let callback = try await open(signIn.authorizeURL)
    let credentials = try await oauth.finish(signIn, callback: callback)
    let dashboardSession = try await session.finish(signIn, callback: callback)
    return (credentials, dashboardSession)
  }

  /// Open `url` in the sheet and return the `junior-ios` URL it ends on.
  private func open(_ url: URL) async throws -> URL {
    defer { session = nil }
    return try await withCheckedThrowingContinuation { continuation in
      let once = ResumeOnce(continuation)
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: Self.callbackScheme) {
        url, error in
        if let url {
          once.resume(returning: url)
        } else {
          once.resume(throwing: error ?? CancellationError())
        }
      }
      session.prefersEphemeralWebBrowserSession = true
      session.presentationContextProvider = self
      self.session = session
      if !session.start() { once.resume(throwing: JuniorAPIError.signIn("The browser did not open.")) }
    }
  }

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated {
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
  }
}

/// Resumes a continuation at most once, for callbacks that race.
private final class ResumeOnce<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Value, Error>?

  init(_ continuation: CheckedContinuation<Value, Error>) { self.continuation = continuation }

  func resume(returning value: Value) { take()?.resume(returning: value) }
  func resume(throwing error: Error) { take()?.resume(throwing: error) }

  private func take() -> CheckedContinuation<Value, Error>? {
    lock.withLock {
      defer { continuation = nil }
      return continuation
    }
  }
}
