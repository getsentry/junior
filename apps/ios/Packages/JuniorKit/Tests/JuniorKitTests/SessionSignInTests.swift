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
  @Test func signInAsksForASessionAndTradesItsCode() async throws {
    let metadata =
      #"{"issuer":"https://junior.example.com","authorization_endpoint":"https://junior.example.com/api/mcp/oauth/authorize","token_endpoint":"https://junior.example.com/api/mcp/oauth/token"}"#
    let session = StubServer.serve { request in
      request.url.path.hasPrefix("/.well-known")
        ? (200, metadata) : (200, #"{"token":"jr_ses_t1","expires_at":"2026-12-25T08:00:00.000Z"}"#)
    }
    let oauth = OAuthClient(server: server, clientID: "https://example.com/client.json", session: session)
    let signIn = try await oauth.begin(redirectURI: "junior-ios://oauth/callback", withSession: true)
    let query = URLComponents(url: signIn.authorizeURL, resolvingAgainstBaseURL: false)!.queryItems!
    func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
    // The session code takes its own verifier, not the MCP one.
    #expect(value("session_code_challenge") != nil)
    #expect(value("session_code_challenge") != value("code_challenge"))

    let client = SessionSignInClient(server: server, session: session)
    await #expect(throws: JuniorAPIError.signIn("This Junior gave no dashboard session. It may need an update.")) {
      try await client.finish(signIn, callback: URL(string: "junior-ios://oauth/callback?code=c")!)
    }
    let signedIn = try await client.finish(
      signIn, callback: URL(string: "junior-ios://oauth/callback?code=c&session_code=s")!)
    #expect(signedIn.token == "jr_ses_t1")
    #expect(signedIn.expiresAt == Date.junior("2026-12-25T08:00:00.000Z"))
    let exchange = try #require(StubServer.requests.last)
    #expect(exchange.url.path == "/api/client/sign-in/token")
    #expect(exchange.form["code"] == "s")
    #expect(exchange.form["code_verifier"].map(codeChallenge) == value("session_code_challenge"))
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
