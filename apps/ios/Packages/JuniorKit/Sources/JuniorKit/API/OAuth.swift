import CryptoKit
import Foundation

/// Every scope of Junior's MCP server. The app asks for all of them.
public let mcpScopes = [
  "conversations:read", "conversations:manage", "conversations:write", "review_items:read", "automations:read",
]

/// Tokens from Junior's MCP OAuth server. An access token lasts an hour, each
/// refresh token works once, and a sign-in ends after 30 days.
public struct OAuthCredentials: Codable, Equatable, Sendable {
  public var server: JuniorServer
  public var clientID: String
  public var tokenEndpoint: URL
  public var accessToken: String
  public var refreshToken: String?
  public var expiresAt: Date
  public var scope: String?

  public init(
    server: JuniorServer, clientID: String, tokenEndpoint: URL, accessToken: String, refreshToken: String?,
    expiresAt: Date, scope: String?
  ) {
    self.server = server
    self.clientID = clientID
    self.tokenEndpoint = tokenEndpoint
    self.accessToken = accessToken
    self.refreshToken = refreshToken
    self.expiresAt = expiresAt
    self.scope = scope
  }

  /// True while the access token has more than a minute left.
  public func isFresh(at now: Date = Date()) -> Bool { expiresAt.timeIntervalSince(now) > 60 }
}

/// One sign-in attempt: the authorization code flow with PKCE (RFC 7636).
public struct OAuthSignIn: Sendable {
  public let authorizeURL: URL
  public let redirectURI: String
  let state: String
  let verifier: String
  let issuer: String
  let tokenEndpoint: URL
}

/// OAuth for one Junior. Junior registers no clients: `clientID` is the URL of
/// the app's Client ID Metadata Document, which names the app and lists its
/// redirect URIs.
public struct OAuthClient: Sendable {
  public let server: JuniorServer
  public let clientID: String
  private let session: URLSession

  public init(server: JuniorServer, clientID: String, session: URLSession = .shared) {
    self.server = server
    self.clientID = clientID
    self.session = session
  }

  private struct Metadata: Decodable {
    var issuer: String
    var authorization_endpoint: URL
    var token_endpoint: URL
  }

  /// Start a sign-in that returns to `redirectURI` (a loopback URL).
  public func begin(redirectURI: String) async throws -> OAuthSignIn {
    let metadataURL = server.page("/.well-known/oauth-authorization-server")!
    let (data, response) = try await load(URLRequest(url: metadataURL))
    guard response.statusCode == 200, let metadata = try? JSONDecoder().decode(Metadata.self, from: data) else {
      throw JuniorAPIError.signIn("This Junior has no MCP sign-in (\(response.statusCode)).")
    }
    let verifier = randomToken(bytes: 32)
    let state = randomToken(bytes: 16)
    var components = URLComponents(url: metadata.authorization_endpoint, resolvingAgainstBaseURL: false)!
    components.queryItems = [
      URLQueryItem(name: "response_type", value: "code"),
      URLQueryItem(name: "client_id", value: clientID),
      URLQueryItem(name: "redirect_uri", value: redirectURI),
      URLQueryItem(name: "scope", value: mcpScopes.joined(separator: " ")),
      URLQueryItem(name: "state", value: state),
      URLQueryItem(name: "code_challenge", value: codeChallenge(verifier)),
      URLQueryItem(name: "code_challenge_method", value: "S256"),
      URLQueryItem(name: "resource", value: server.mcpURL.absoluteString),
    ]
    return OAuthSignIn(
      authorizeURL: components.url!, redirectURI: redirectURI, state: state, verifier: verifier,
      issuer: metadata.issuer, tokenEndpoint: metadata.token_endpoint)
  }

  /// Finish a sign-in with the URL that the browser returned to.
  public func finish(_ signIn: OAuthSignIn, callback: URL) async throws -> OAuthCredentials {
    let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
    func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
    guard value("state") == signIn.state else { throw JuniorAPIError.signIn("The sign-in response did not match.") }
    if let issuer = value("iss"), issuer != signIn.issuer {
      throw JuniorAPIError.signIn("The sign-in response came from another server.")
    }
    if let error = value("error") {
      throw JuniorAPIError.signIn(
        error == "access_denied" ? "You did not allow access." : value("error_description") ?? error)
    }
    guard let code = value("code") else { throw JuniorAPIError.signIn("The sign-in response had no code.") }
    return try await token(
      endpoint: signIn.tokenEndpoint,
      [
        "grant_type": "authorization_code", "code": code, "code_verifier": signIn.verifier,
        "redirect_uri": signIn.redirectURI,
      ])
  }

  /// Trade the refresh token for new tokens. Throws `.signedOut` when Junior
  /// no longer accepts it.
  public func refresh(_ credentials: OAuthCredentials) async throws -> OAuthCredentials {
    guard let refreshToken = credentials.refreshToken else { throw JuniorAPIError.signedOut }
    return try await token(
      endpoint: credentials.tokenEndpoint, ["grant_type": "refresh_token", "refresh_token": refreshToken])
  }

  private struct TokenResponse: Decodable {
    var access_token: String
    var expires_in: Double?
    var refresh_token: String?
    var scope: String?
  }

  private struct TokenError: Decodable {
    var error: String
    var error_description: String?
  }

  private func token(endpoint: URL, _ fields: [String: String]) async throws -> OAuthCredentials {
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let form = fields.merging(["client_id": clientID, "resource": server.mcpURL.absoluteString]) { a, _ in a }
    request.httpBody = Data(
      form.sorted { $0.key < $1.key }.map { "\(formEncode($0.key))=\(formEncode($0.value))" }
        .joined(separator: "&").utf8)
    let (data, response) = try await load(request)
    guard response.statusCode == 200 else {
      let error = try? JSONDecoder().decode(TokenError.self, from: data)
      if error?.error == "invalid_grant", fields["grant_type"] == "refresh_token" { throw JuniorAPIError.signedOut }
      throw JuniorAPIError.signIn(error?.error_description ?? error?.error ?? "Junior returned \(response.statusCode).")
    }
    guard let tokens = try? JSONDecoder().decode(TokenResponse.self, from: data) else {
      throw JuniorAPIError.signIn("Junior sent a token response this app cannot read.")
    }
    return OAuthCredentials(
      server: server, clientID: clientID, tokenEndpoint: endpoint, accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token, expiresAt: Date().addingTimeInterval(tokens.expires_in ?? 3600),
      scope: tokens.scope)
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

/// The PKCE S256 challenge for a verifier.
func codeChallenge(_ verifier: String) -> String {
  base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
}

private func randomToken(bytes count: Int) -> String {
  var generator = SystemRandomNumberGenerator()
  return base64URL(Data((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) }))
}

private func base64URL(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

private func formEncode(_ value: String) -> String {
  value.addingPercentEncoding(
    withAllowedCharacters: CharacterSet(
      charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) ?? value
}
