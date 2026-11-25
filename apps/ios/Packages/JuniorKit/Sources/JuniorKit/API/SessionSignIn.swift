import Foundation

/// The app's sign-in session. It calls the dashboard API (`/api/*`) and gets
/// the MCP tokens. It ends 30 days after sign-in, and use does not extend it.
/// The MCP grant that it gets ends no later than the session.
public struct SessionCredentials: Codable, Equatable, Sendable {
  public var server: JuniorServer
  public var token: String
  public var expiresAt: Date

  public init(server: JuniorServer, token: String, expiresAt: Date) {
    self.server = server
    self.token = token
    self.expiresAt = expiresAt
  }
}

/// One sign-in attempt: the authorization code flow with PKCE (RFC 7636).
public struct SessionSignIn: Sendable {
  public let authorizeURL: URL
  let state: String
  let verifier: String
}

/// Signs the app in: the user confirms the app on Junior's sign-in page,
/// whose redirect carries a code that this trades for a session at
/// `/api/client/sign-in/token`. It ends the session at sign-out.
public struct SessionSignInClient: Sendable {
  public let server: JuniorServer
  private let session: URLSession

  public init(server: JuniorServer, session: URLSession = .shared) {
    self.server = server
    self.session = session
  }

  private struct TokenResponse: Decodable {
    var token: String
    var expires_at: Date
  }

  private struct TokenError: Decodable {
    var error_description: String?
  }

  /// Start a sign-in for the app client `clientID` that returns to
  /// `redirectURI`. Open `authorizeURL` in a browser sheet.
  public func begin(clientID: String, redirectURI: String) -> SessionSignIn {
    let verifier = randomToken(bytes: 32)
    let state = randomToken(bytes: 16)
    var components = URLComponents(
      url: server.page("/_junior/client/sign-in/authorize")!, resolvingAgainstBaseURL: false)!
    components.queryItems = [
      URLQueryItem(name: "client_id", value: clientID),
      URLQueryItem(name: "redirect_uri", value: redirectURI),
      URLQueryItem(name: "state", value: state),
      URLQueryItem(name: "code_challenge", value: codeChallenge(verifier)),
      URLQueryItem(name: "code_challenge_method", value: "S256"),
    ]
    return SessionSignIn(authorizeURL: components.url!, state: state, verifier: verifier)
  }

  /// Finish a sign-in with the URL that the browser sheet returned to.
  public func finish(_ signIn: SessionSignIn, callback: URL) async throws -> SessionCredentials {
    let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
    func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
    guard value("state") == signIn.state else { throw JuniorAPIError.signIn("The sign-in response did not match.") }
    if let error = value("error") {
      throw JuniorAPIError.signIn(
        error == "access_denied" ? "You did not allow access." : value("error_description") ?? error)
    }
    guard let code = value("code") else { throw JuniorAPIError.signIn("The sign-in response had no code.") }
    var request = URLRequest(url: server.page("/api/client/sign-in/token")!)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data(
      "code=\(formEncode(code))&code_verifier=\(formEncode(signIn.verifier))".utf8)
    let (data, response) = try await load(request)
    guard response.statusCode == 200 else {
      let error = try? JSONDecoder().decode(TokenError.self, from: data)
      Log.oauth.error("Session sign-in got HTTP \(response.statusCode, privacy: .public)")
      throw JuniorAPIError.signIn(error?.error_description ?? "Junior returned \(response.statusCode).")
    }
    guard let body = try? JSONDecoder.junior.decode(TokenResponse.self, from: data) else {
      throw JuniorAPIError.signIn("Junior sent a session this app cannot read.")
    }
    return SessionCredentials(server: server, token: body.token, expiresAt: body.expires_at)
  }

  /// End the session on the server. When that fails, it still ends at its
  /// expiry.
  public func signOut(_ credentials: SessionCredentials) async {
    var request = URLRequest(url: server.page("/api/client/sign-out")!)
    request.httpMethod = "POST"
    request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
    _ = try? await load(request)
  }

  private func load(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    do {
      let (data, response) = try await session.data(for: request)
      return (data, response as! HTTPURLResponse)
    } catch {
      throw JuniorAPIError.offline(error.localizedDescription)
    }
  }
}
