import CryptoKit
import Foundation

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

/// MCP tokens for one Junior. The app gets them with its sign-in session and
/// refreshes them at the MCP token endpoint. Junior registers no clients:
/// `clientID` is the app's Client ID Metadata Document URL, which every
/// Junior knows.
public struct OAuthClient: Sendable {
  public let server: JuniorServer
  public let clientID: String
  private let session: URLSession

  public init(server: JuniorServer, clientID: String, session: URLSession = .shared) {
    self.server = server
    self.clientID = clientID
    self.session = session
  }

  /// Get MCP tokens with the app's sign-in session. The grant ends with the
  /// session, and its tokens refresh at the MCP token endpoint.
  public func tokens(for session: SessionCredentials) async throws -> OAuthCredentials {
    var request = URLRequest(url: server.page("/api/client/mcp-token")!)
    request.httpMethod = "POST"
    request.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    return try await send(request, grantType: "session", endpoint: server.page("/api/mcp/oauth/token")!)
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
    return try await send(request, grantType: fields["grant_type"] ?? "token", endpoint: endpoint)
  }

  /// Send one token request. `endpoint` is where the tokens refresh.
  private func send(_ request: URLRequest, grantType: String, endpoint: URL) async throws -> OAuthCredentials {
    let (data, response) = try await load(request)
    guard response.statusCode == 200 else {
      let error = try? JSONDecoder().decode(TokenError.self, from: data)
      Log.oauth.error(
        "\(grantType, privacy: .public) got HTTP \(response.statusCode, privacy: .public): \(error?.error ?? "no error code", privacy: .public)"
      )
      if error?.error == "invalid_grant", grantType == "refresh_token" { throw JuniorAPIError.signedOut }
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

func randomToken(bytes count: Int) -> String {
  var generator = SystemRandomNumberGenerator()
  return base64URL(Data((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) }))
}

private func base64URL(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

func formEncode(_ value: String) -> String {
  value.addingPercentEncoding(
    withAllowedCharacters: CharacterSet(
      charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) ?? value
}
