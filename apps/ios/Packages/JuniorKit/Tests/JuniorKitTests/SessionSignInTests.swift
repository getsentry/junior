import Foundation
import Testing

@testable import JuniorKit

final class MemorySessionStore: SessionStore, @unchecked Sendable {
  private let lock = NSLock()
  private var value: SessionCredentials?
  init(_ value: SessionCredentials?) { self.value = value }
  func load() -> SessionCredentials? { lock.withLock { value } }
  func save(_ credentials: SessionCredentials?) { lock.withLock { value = credentials } }
}

// In the `MCPClientTests` suite, which runs serialized, because `StubServer`
// holds one handler at a time.
extension MCPClientTests {
  @Test func signInTradesItsCodeForASessionThatGetsMCPTokens() async throws {
    let session = StubServer.serve { request in
      if request.url.path == "/api/client/mcp-token" {
        return request.headers["Authorization"] == "Bearer jr_ses_t1" ? (200, tokens) : (401, "")
      }
      return (200, #"{"token":"jr_ses_t1","expires_at":"2026-12-25T08:00:00.000Z"}"#)
    }
    let client = SessionSignInClient(server: server, session: session)
    let signIn = client.begin(clientID: "https://example.com/client.json", redirectURI: "junior-ios://oauth/callback")
    let authorize = try #require(URLComponents(url: signIn.authorizeURL, resolvingAgainstBaseURL: false))
    func value(_ name: String) -> String? { authorize.queryItems?.first { $0.name == name }?.value }
    #expect(authorize.path == "/_junior/client/sign-in/authorize")
    #expect(value("client_id") == "https://example.com/client.json")
    #expect(value("redirect_uri") == "junior-ios://oauth/callback")
    #expect(value("code_challenge_method") == "S256")
    let state = try #require(value("state"))

    await #expect(throws: JuniorAPIError.signIn("The sign-in response did not match.")) {
      try await client.finish(signIn, callback: URL(string: "junior-ios://oauth/callback?code=c&state=wrong")!)
    }
    await #expect(throws: JuniorAPIError.signIn("You did not allow access.")) {
      try await client.finish(
        signIn, callback: URL(string: "junior-ios://oauth/callback?error=access_denied&state=\(state)")!)
    }
    let signedIn = try await client.finish(
      signIn, callback: URL(string: "junior-ios://oauth/callback?code=c&state=\(state)")!)
    #expect(signedIn.token == "jr_ses_t1")
    #expect(signedIn.expiresAt == Date.junior("2026-12-25T08:00:00.000Z"))
    let exchange = try #require(StubServer.requests.last)
    #expect(exchange.url.path == "/api/client/sign-in/token")
    #expect(exchange.form["code"] == "c")
    #expect(exchange.form["code_verifier"].map(codeChallenge) == value("code_challenge"))

    // The session gets MCP tokens that refresh at the MCP token endpoint.
    let oauth = OAuthClient(server: server, clientID: "https://example.com/client.json", session: session)
    let mcp = try await oauth.tokens(for: signedIn)
    #expect(mcp.accessToken == "a2")
    #expect(mcp.refreshToken == "r2")
    #expect(mcp.tokenEndpoint.absoluteString == "https://junior.example.com/api/mcp/oauth/token")
    #expect(StubServer.requests.last?.url.path == "/api/client/mcp-token")
  }

  @Test func dashboardClientSendsTheSessionAndSignsOutOn401() async throws {
    struct Me: Decodable, Sendable { var email: String }
    let session = StubServer.serve { request in
      request.headers["Authorization"] == "Bearer jr_ses_t1" ? (200, #"{"email":"person@example.com"}"#) : (401, "")
    }
    let store = MemorySessionStore(
      SessionCredentials(server: server, token: "jr_ses_t1", expiresAt: .distantFuture))
    let client = DashboardClient(server: server, store: store, session: session)
    let me = try await client.get("/api/me", as: Me.self)
    #expect(me.email == "person@example.com")
    #expect(StubServer.requests.last?.url.absoluteString == "https://junior.example.com/api/me")

    // A revoked or expired session gets 401. It cannot refresh.
    await client.signIn(SessionCredentials(server: server, token: "jr_ses_revoked", expiresAt: .distantFuture))
    await #expect(throws: JuniorAPIError.signedOut) { try await client.get("/api/me", as: Me.self) }
    #expect(store.load() == nil)
    #expect(await client.isSignedIn == false)
    // A session past its expiry is forgotten without a request.
    await client.signIn(SessionCredentials(server: server, token: "jr_ses_t1", expiresAt: .distantPast))
    let requests = StubServer.requests.count
    await #expect(throws: JuniorAPIError.signedOut) { try await client.get("/api/me", as: Me.self) }
    #expect(store.load() == nil)
    #expect(StubServer.requests.count == requests)
  }
}
