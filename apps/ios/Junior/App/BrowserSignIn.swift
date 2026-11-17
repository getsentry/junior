import AuthenticationServices
import JuniorKit
import Network
import UIKit

/// Sign in to Junior's MCP server in the system browser sheet. Junior accepts
/// only `https` and loopback `http` redirect URIs, so the app listens on
/// `127.0.0.1` for the one redirect (RFC 8252), as desktop MCP clients do.
@MainActor
final class BrowserSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
  private var session: ASWebAuthenticationSession?

  func run(_ oauth: OAuthClient) async throws -> OAuthCredentials {
    let receiver = try await LoopbackReceiver.start()
    defer { receiver.stop() }
    let signIn = try await oauth.begin(redirectURI: "http://127.0.0.1:\(receiver.port)/callback")
    let callback: URL = try await withCheckedThrowingContinuation { continuation in
      let once = ResumeOnce(continuation)
      // The redirect goes to the receiver, never to this scheme; the sheet
      // ends when the receiver has the code, or when the person cancels.
      let session = ASWebAuthenticationSession(url: signIn.authorizeURL, callbackURLScheme: "junior-ios") { _, error in
        once.resume(throwing: error ?? CancellationError())
      }
      session.prefersEphemeralWebBrowserSession = true
      session.presentationContextProvider = self
      self.session = session
      receiver.onCallback = { [weak self] url in
        once.resume(returning: url)
        Task { @MainActor in self?.session?.cancel() }
      }
      if !session.start() { once.resume(throwing: JuniorAPIError.signIn("The browser did not open.")) }
    }
    session = nil
    return try await oauth.finish(signIn, callback: callback)
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

/// A one-request HTTP server on `127.0.0.1` that takes the OAuth redirect.
final class LoopbackReceiver: @unchecked Sendable {
  private let listener: NWListener
  private let queue = DispatchQueue(label: "io.sentry.junior.oauth-loopback")
  private(set) var port: UInt16 = 0
  var onCallback: (@Sendable (URL) -> Void)?

  private init(listener: NWListener) { self.listener = listener }

  static func start() async throws -> LoopbackReceiver {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
    let receiver = LoopbackReceiver(listener: try NWListener(using: parameters))
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      let once = ResumeOnce(continuation)
      receiver.listener.stateUpdateHandler = { state in
        switch state {
        case .ready:
          receiver.port = receiver.listener.port?.rawValue ?? 0
          once.resume(returning: ())
        case .failed(let error): once.resume(throwing: error)
        default: break
        }
      }
      receiver.listener.newConnectionHandler = { receiver.serve($0) }
      receiver.listener.start(queue: receiver.queue)
    }
    return receiver
  }

  func stop() { listener.cancel() }

  private func serve(_ connection: NWConnection) {
    connection.start(queue: queue)
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, _, _ in
      guard let self else { return connection.cancel() }
      // "GET /callback?code=…&state=… HTTP/1.1"
      let line = data.flatMap { String(data: $0, encoding: .utf8) }?.split(separator: "\r\n").first ?? ""
      let target = line.split(separator: " ").dropFirst().first.map(String.init) ?? ""
      let url = URL(string: "http://127.0.0.1:\(self.port)\(target)")
      let isCallback = url?.path == "/callback"
      let body =
        isCallback
        ? "<!doctype html><meta name=viewport content='width=device-width'><title>Junior</title><body style='font:17px -apple-system;text-align:center;padding:48px'>Signed in. Return to Junior.</body>"
        : "Not found"
      let response =
        "HTTP/1.1 \(isCallback ? "200 OK" : "404 Not Found")\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
      connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
      if isCallback, let url { self.onCallback?(url) }
    }
  }
}
