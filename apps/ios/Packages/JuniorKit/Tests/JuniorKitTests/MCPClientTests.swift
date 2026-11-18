import Foundation
import Testing

@testable import JuniorKit

/// Serves scripted responses to one URLSession and records the requests.
final class StubServer: URLProtocol, @unchecked Sendable {
  struct Request: Sendable {
    var url: URL
    var headers: [String: String]
    var body: Data
    var form: [String: String] {
      let text = String(decoding: body, as: UTF8.self)
      return Dictionary(
        uniqueKeysWithValues: text.split(separator: "&").map { pair in
          let parts = pair.split(separator: "=", maxSplits: 1).map { String($0).removingPercentEncoding ?? "" }
          return (parts[0], parts.count > 1 ? parts[1] : "")
        })
    }
  }

  private static let lock = NSLock()
  nonisolated(unsafe) private static var handler: (@Sendable (Request) -> (Int, String))?
  nonisolated(unsafe) private static var recorded: [Request] = []

  static func serve(_ handler: @escaping @Sendable (Request) -> (Int, String)) -> URLSession {
    lock.withLock {
      self.handler = handler
      recorded = []
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubServer.self]
    return URLSession(configuration: configuration)
  }

  static var requests: [Request] { lock.withLock { recorded } }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}

  override func startLoading() {
    var body = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
      stream.open()
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        body.append(buffer, count: count)
      }
      stream.close()
    }
    let recordedRequest = Request(
      url: request.url!, headers: request.allHTTPHeaderFields ?? [:], body: body)
    let handler = Self.lock.withLock {
      Self.recorded.append(recordedRequest)
      return Self.handler
    }
    let (status, text) = handler?(recordedRequest) ?? (500, "")
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(text.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
}

final class MemoryStore: CredentialStore, @unchecked Sendable {
  private let lock = NSLock()
  private var value: OAuthCredentials?
  init(_ value: OAuthCredentials?) { self.value = value }
  func load() -> OAuthCredentials? { lock.withLock { value } }
  func save(_ credentials: OAuthCredentials?) { lock.withLock { value = credentials } }
}

let server = JuniorServer(baseURL: URL(string: "https://junior.example.com")!)

func credentials(access: String = "a1", refresh: String? = "r1", expiresIn: TimeInterval = 3600) -> OAuthCredentials {
  OAuthCredentials(
    server: server, clientID: "https://example.com/client.json",
    tokenEndpoint: URL(string: "https://junior.example.com/api/mcp/oauth/token")!, accessToken: access,
    refreshToken: refresh, expiresAt: Date().addingTimeInterval(expiresIn), scope: nil)
}

let emptyFeed = #"{"jsonrpc":"2.0","id":1,"result":{"content":[],"structuredContent":{"conversations":[]}}}"#
let tokens = #"{"access_token":"a2","token_type":"Bearer","expires_in":3600,"refresh_token":"r2"}"#

@Suite(.serialized) struct MCPClientTests {
  @Test func pkceChallengeMatchesRFC7636() {
    #expect(
      codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  }

  @Test func callsATool() async throws {
    let session = StubServer.serve { _ in (200, emptyFeed) }
    let client = MCPClient(server: server, store: MemoryStore(credentials()), session: session)
    let list = try await client.call("searchConversations", ["status": "archived"], as: ConversationList.self)
    #expect(list.conversations.isEmpty)
    let request = try #require(StubServer.requests.first)
    #expect(request.url.absoluteString == "https://junior.example.com/api/mcp")
    #expect(request.headers["Authorization"] == "Bearer a1")
    #expect(request.headers["Accept"] == "application/json, text/event-stream")
    let body = try JSONDecoder().decode(JSONValue.self, from: request.body)
    #expect(body["method"]?.string == "tools/call")
    #expect(body["params"]?["name"]?.string == "searchConversations")
    #expect(body["params"]?["arguments"]?["status"]?.string == "archived")
  }

  @Test func toolErrorsCarryTheirMessage() async {
    let session = StubServer.serve { _ in
      (
        200,
        #"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Conversation not found."}],"isError":true}}"#
      )
    }
    let client = MCPClient(server: server, store: MemoryStore(credentials()), session: session)
    await #expect(throws: JuniorAPIError.tool("Conversation not found.")) {
      try await client.call("getConversation", ["conversationId": "x"], as: ConversationState.self)
    }
  }

  @Test func refreshesOnceAfter401() async throws {
    let session = StubServer.serve { request in
      if request.url.path == "/api/mcp/oauth/token" { return (200, tokens) }
      return request.headers["Authorization"] == "Bearer a2" ? (200, emptyFeed) : (401, "")
    }
    let store = MemoryStore(credentials())
    let client = MCPClient(server: server, store: store, session: session)
    _ = try await client.call("searchConversations", as: ConversationList.self)
    let refresh = try #require(StubServer.requests.first { $0.url.path == "/api/mcp/oauth/token" })
    #expect(refresh.form["grant_type"] == "refresh_token")
    #expect(refresh.form["refresh_token"] == "r1")
    #expect(refresh.form["client_id"] == "https://example.com/client.json")
    #expect(refresh.form["resource"] == "https://junior.example.com/api/mcp")
    #expect(store.load()?.refreshToken == "r2")
  }

  @Test func concurrentCallsSpendOneRefreshToken() async throws {
    let session = StubServer.serve { request in
      request.url.path == "/api/mcp/oauth/token" ? (200, tokens) : (200, emptyFeed)
    }
    let client = MCPClient(server: server, store: MemoryStore(credentials(expiresIn: 10)), session: session)
    try await withThrowingTaskGroup(of: Void.self) { group in
      for _ in 0..<5 {
        group.addTask { _ = try await client.call("searchConversations", as: ConversationList.self) }
      }
      try await group.waitForAll()
    }
    #expect(StubServer.requests.filter { $0.url.path == "/api/mcp/oauth/token" }.count == 1)
    #expect(
      StubServer.requests.filter { $0.url.path == "/api/mcp" }.allSatisfy { $0.headers["Authorization"] == "Bearer a2" }
    )
  }

  @Test func rejectedRefreshSignsOut() async {
    let session = StubServer.serve { request in
      request.url.path == "/api/mcp/oauth/token"
        ? (400, #"{"error":"invalid_grant","error_description":"Expired."}"#) : (401, "")
    }
    let store = MemoryStore(credentials())
    let client = MCPClient(server: server, store: store, session: session)
    await #expect(throws: JuniorAPIError.signedOut) {
      try await client.call("searchConversations", as: ConversationList.self)
    }
    #expect(store.load() == nil)
    #expect(await client.isSignedIn == false)
  }

  @Test func signInChecksTheResponse() async throws {
    let metadata =
      #"{"issuer":"https://junior.example.com","authorization_endpoint":"https://junior.example.com/api/mcp/oauth/authorize","token_endpoint":"https://junior.example.com/api/mcp/oauth/token"}"#
    let session = StubServer.serve { request in
      request.url.path.hasPrefix("/.well-known") ? (200, metadata) : (200, tokens)
    }
    let oauth = OAuthClient(server: server, clientID: "https://example.com/client.json", session: session)
    let signIn = try await oauth.begin(redirectURI: "http://127.0.0.1:5555/callback")
    let query = URLComponents(url: signIn.authorizeURL, resolvingAgainstBaseURL: false)!.queryItems!
    func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
    #expect(value("code_challenge_method") == "S256")
    #expect(value("resource") == "https://junior.example.com/api/mcp")
    #expect(value("scope")?.contains("conversations:write") == true)

    await #expect(throws: JuniorAPIError.signIn("The sign-in response did not match.")) {
      try await oauth.finish(signIn, callback: URL(string: "http://127.0.0.1:5555/callback?code=c&state=wrong")!)
    }
    await #expect(throws: JuniorAPIError.signIn("You did not allow access.")) {
      try await oauth.finish(
        signIn, callback: URL(string: "http://127.0.0.1:5555/callback?error=access_denied&state=\(value("state")!)")!)
    }
    let signedIn = try await oauth.finish(
      signIn,
      callback: URL(
        string: "http://127.0.0.1:5555/callback?code=c&state=\(value("state")!)&iss=https%3A%2F%2Fjunior.example.com")!)
    #expect(signedIn.accessToken == "a2")
    let exchange = try #require(StubServer.requests.last)
    #expect(exchange.form["code_verifier"].map(codeChallenge) == value("code_challenge"))
    #expect(exchange.form["redirect_uri"] == "http://127.0.0.1:5555/callback")
  }
}
