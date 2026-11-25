import Foundation

/// A session for the dashboard API (`/api/*`). It ends 30 days after sign-in,
/// the same as the MCP grant, and use does not extend it. The MCP sign-in
/// gives it, but it is a separate credential.
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

/// Trades the session code from the MCP sign-in for a dashboard session at
/// `/api/client/sign-in/token`, and ends the session at sign-out.
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

  /// Finish a sign-in that `OAuthClient.begin(redirectURI:withSession:)`
  /// started, after `OAuthClient.finish` checked the callback.
  public func finish(_ signIn: OAuthSignIn, callback: URL) async throws -> SessionCredentials {
    let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
    guard let verifier = signIn.sessionVerifier, let code = items.first(where: { $0.name == "session_code" })?.value
    else { throw JuniorAPIError.signIn("This Junior gave no dashboard session. It may need an update.") }
    var request = URLRequest(url: server.page("/api/client/sign-in/token")!)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data(
      "code=\(formEncode(code))&code_verifier=\(formEncode(verifier))".utf8)
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
