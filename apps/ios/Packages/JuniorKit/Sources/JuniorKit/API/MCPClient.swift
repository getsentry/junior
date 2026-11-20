import Foundation

/// Where sign-in credentials live between launches. The app keeps them in the
/// Keychain.
public protocol CredentialStore: Sendable {
  func load() -> OAuthCredentials?
  func save(_ credentials: OAuthCredentials?)
}

/// Sends one HTTP request. `URLSession` by default; the demo answers in
/// process.
public typealias HTTPTransport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

/// Client for Junior's MCP server (`/api/mcp`), the public API. Each tool call
/// is one JSON-RPC POST, which Junior answers with JSON. The client refreshes
/// the access token before it expires and once more after a 401; an actor, so
/// two calls never spend the same single-use refresh token.
public actor MCPClient {
  public nonisolated let server: JuniorServer
  private let store: CredentialStore
  private let session: URLSession
  private let transport: HTTPTransport
  private var credentials: OAuthCredentials?
  private var refreshing: Task<OAuthCredentials, Error>?
  private var nextID = 0

  public init(
    server: JuniorServer, store: CredentialStore, session: URLSession = .shared, transport: HTTPTransport? = nil
  ) {
    self.server = server
    self.store = store
    self.session = session
    self.transport = transport ?? { request in try await session.data(for: request) }
    credentials = store.load().flatMap { $0.server == server ? $0 : nil }
  }

  public var isSignedIn: Bool { credentials != nil }

  public func signIn(_ credentials: OAuthCredentials) {
    self.credentials = credentials
    store.save(credentials)
  }

  public func signOut() {
    credentials = nil
    refreshing = nil
    store.save(nil)
  }

  /// Call one tool and decode its structured result.
  public func call<Result: Decodable & Sendable>(
    _ tool: String, _ arguments: [String: JSONValue] = [:], as type: Result.Type = Result.self
  ) async throws -> Result {
    let data = try await rpc("tools/call", ["name": .string(tool), "arguments": .object(arguments)])
    let result = try decode(RPCEnvelope<ToolResult<Result>>.self, data, tool: tool)
    if result.isError == true {
      let text = result.content?.compactMap(\.text).joined(separator: "\n")
      throw JuniorAPIError.tool(text?.isEmpty == false ? text! : "\(tool) failed.")
    }
    guard let value = result.structuredContent else {
      throw JuniorAPIError.decoding("\(tool) returned no structured result.")
    }
    return value
  }

  public struct ServerInfo: Decodable, Sendable {
    public var name: String
    public var version: String?
  }

  /// The server name and Junior version, from MCP `initialize`.
  public func serverInfo() async throws -> ServerInfo {
    struct Initialized: Decodable, Sendable { var serverInfo: ServerInfo }
    let data = try await rpc(
      "initialize",
      [
        "protocolVersion": .string(Self.protocolVersion), "capabilities": .object([:]),
        "clientInfo": .object(["name": "junior-ios", "version": "0.1.0"]),
      ])
    return try decode(RPCEnvelope<Initialized>.self, data, tool: "initialize").serverInfo
  }

  static let protocolVersion = "2025-06-18"

  private func rpc(_ method: String, _ params: [String: JSONValue]) async throws -> Data {
    var token = try await accessToken()
    nextID += 1
    let body = try JSONEncoder().encode(
      JSONValue.object([
        "jsonrpc": "2.0", "id": .number(Double(nextID)), "method": .string(method), "params": .object(params),
      ]))
    for attempt in 0..<2 {
      var request = URLRequest(url: server.mcpURL)
      request.httpMethod = "POST"
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
      request.setValue(Self.protocolVersion, forHTTPHeaderField: "MCP-Protocol-Version")
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      let (data, response) = try await load(request)
      if response.statusCode == 401 {
        guard attempt == 0 else { break }
        token = try await refreshedToken(replacing: token)
        continue
      }
      guard (200..<300).contains(response.statusCode) else {
        throw JuniorAPIError.server(status: response.statusCode, message: nil)
      }
      return data
    }
    signOut()
    throw JuniorAPIError.signedOut
  }

  private func accessToken() async throws -> String {
    guard let credentials else { throw JuniorAPIError.signedOut }
    if credentials.isFresh() { return credentials.accessToken }
    return try await refreshedToken(replacing: credentials.accessToken)
  }

  /// A new access token after `rejected` failed. When another call already
  /// refreshed, its token is used instead of spending the refresh token again.
  private func refreshedToken(replacing rejected: String) async throws -> String {
    if let refreshing { return try await refreshing.value.accessToken }
    guard let current = credentials else { throw JuniorAPIError.signedOut }
    if current.accessToken != rejected, current.isFresh() { return current.accessToken }
    let session = session
    let task = Task {
      try await OAuthClient(server: current.server, clientID: current.clientID, session: session).refresh(current)
    }
    refreshing = task
    defer { refreshing = nil }
    do {
      let renewed = try await task.value
      // A sign-out while the refresh ran wins.
      guard credentials != nil else { throw JuniorAPIError.signedOut }
      credentials = renewed
      store.save(renewed)
      return renewed.accessToken
    } catch JuniorAPIError.signedOut {
      signOut()
      throw JuniorAPIError.signedOut
    }
  }

  private func decode<Result: Decodable>(_ type: RPCEnvelope<Result>.Type, _ data: Data, tool: String) throws -> Result
  {
    let envelope: RPCEnvelope<Result>
    do {
      envelope = try JSONDecoder.junior.decode(type, from: data)
    } catch let error as DecodingError {
      throw JuniorAPIError.decoding("\(tool): \(describe(error))")
    }
    if let error = envelope.error { throw JuniorAPIError.server(status: 200, message: error.message) }
    guard let result = envelope.result else { throw JuniorAPIError.decoding("\(tool) returned nothing.") }
    return result
  }

  private func load(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    do {
      let (data, response) = try await transport(request)
      return (data, response as! HTTPURLResponse)
    } catch {
      throw JuniorAPIError.offline(error.localizedDescription)
    }
  }
}

struct RPCEnvelope<Result: Decodable>: Decodable {
  var result: Result?
  var error: RPCError?
}

struct RPCError: Decodable {
  var code: Int
  var message: String
}

struct ToolResult<Value: Decodable>: Decodable {
  struct Content: Decodable { var text: String? }
  var content: [Content]?
  var structuredContent: Value?
  var isError: Bool?
}
