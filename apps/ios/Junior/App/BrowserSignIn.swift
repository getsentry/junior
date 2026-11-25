import AuthenticationServices
import JuniorKit
import UIKit

/// Sign in to Junior's MCP server in the system browser sheet. Junior knows
/// this app's client, and redirects to the app's `junior-ios` URL scheme; the
/// sheet gives that redirect back only to this app.
@MainActor
final class BrowserSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
  private static let callbackScheme = "junior-ios"
  private var session: ASWebAuthenticationSession?

  func run(_ oauth: OAuthClient) async throws -> OAuthCredentials {
    let signIn = try await oauth.begin(redirectURI: "\(Self.callbackScheme)://oauth/callback")
    #if DEBUG
      // UI tests sign in to the mock server, which approves at once. The
      // sheet's view service is slow to start on CI, and a relaunch while it
      // goes away can hang, so they read the redirect without the sheet.
      if LaunchOptions.current.signInWithoutSheet {
        return try await oauth.finish(signIn, callback: Self.redirect(from: signIn.authorizeURL))
      }
    #endif
    defer { session = nil }
    let callback: URL = try await withCheckedThrowingContinuation { continuation in
      let once = ResumeOnce(continuation)
      let session = ASWebAuthenticationSession(url: signIn.authorizeURL, callbackURLScheme: Self.callbackScheme) {
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
    return try await oauth.finish(signIn, callback: callback)
  }

  #if DEBUG
    /// The `junior-ios` URL that the authorize page redirects to, read
    /// without following it.
    private static func redirect(from authorizeURL: URL) async throws -> URL {
      let (_, response) = try await URLSession.shared.data(from: authorizeURL, delegate: StopAtRedirect())
      guard let location = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Location"),
        let callback = URL(string: location), callback.scheme == callbackScheme
      else { throw JuniorAPIError.signIn("The sign-in did not return to the app.") }
      return callback
    }
  #endif

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated {
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
  }
}

#if DEBUG
  /// Ends a request at its first redirect, so the response is the redirect.
  private final class StopAtRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(
      _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
      newRequest request: URLRequest
    ) async -> URLRequest? {
      nil
    }
  }
#endif

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
