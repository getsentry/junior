import Foundation

/// Where the dashboard session lives between launches. The app keeps it in
/// the Keychain.
public protocol SessionStore: Sendable {
  func load() -> SessionCredentials?
  func save(_ credentials: SessionCredentials?)
}

/// Client for the dashboard API (`/api/*`), for what MCP does not cover. It
/// sends the session token as a bearer token. The session cannot refresh, so
/// a 401 means Junior ended it and the app signs in again.
public actor DashboardClient {
  public nonisolated let server: JuniorServer
  private let store: SessionStore
  private let transport: HTTPTransport
  private var credentials: SessionCredentials?

  public init(
    server: JuniorServer, store: SessionStore, session: URLSession = .shared, transport: HTTPTransport? = nil
  ) {
    self.server = server
    self.store = store
    self.transport = transport ?? { request in try await session.data(for: request) }
    credentials = store.load().flatMap { $0.server == server ? $0 : nil }
  }

  public var isSignedIn: Bool { credentials.map { $0.expiresAt > Date() } ?? false }

  public func signIn(_ credentials: SessionCredentials) {
    self.credentials = credentials
    store.save(credentials)
  }

  /// Forget the session and return it, so the caller can end it on the server.
  @discardableResult
  public func signOut() -> SessionCredentials? {
    defer {
      credentials = nil
      store.save(nil)
    }
    return credentials
  }

  /// GET one dashboard API path and decode its JSON.
  public func get<Result: Decodable & Sendable>(
    _ path: String, query: [URLQueryItem] = [], as type: Result.Type = Result.self
  ) async throws -> Result {
    let data = try await fetch(path, query: query)
    do {
      return try JSONDecoder.junior.decode(type, from: data)
    } catch let error as DecodingError {
      throw JuniorAPIError.decoding("\(path): \(describe(error))")
    }
  }

  /// GET the bytes at one dashboard API path, such as a profile photo. Only
  /// an `/api/` path on this server gets the session token.
  public func data(_ path: String) async throws -> Data {
    guard path.hasPrefix("/api/") else { throw JuniorAPIError.decoding("Not a dashboard API path: \(path)") }
    return try await fetch(path, query: [], accept: "*/*")
  }

  private func fetch(_ path: String, query: [URLQueryItem], accept: String = "application/json") async throws -> Data {
    guard let credentials else { throw JuniorAPIError.signedOut }
    guard credentials.expiresAt > Date() else {
      Log.oauth.notice("Signed out: the dashboard session expired")
      signOut()
      throw JuniorAPIError.signedOut
    }
    var components = URLComponents(url: server.page(path)!, resolvingAgainstBaseURL: false)!
    if !query.isEmpty { components.queryItems = query }
    var request = URLRequest(url: components.url!)
    request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
    request.setValue(accept, forHTTPHeaderField: "Accept")
    let started = ContinuousClock.now
    let (data, response) = try await load(request)
    let milliseconds = Int(started.duration(to: .now) / .milliseconds(1))
    if response.statusCode == 401 {
      Log.oauth.notice("Signed out: Junior rejected the dashboard session")
      signOut()
      throw JuniorAPIError.signedOut
    }
    guard (200..<300).contains(response.statusCode) else {
      Log.api.error(
        "GET \(path, privacy: .public) got HTTP \(response.statusCode, privacy: .public) in \(milliseconds)ms")
      throw JuniorAPIError.server(status: response.statusCode, message: nil)
    }
    Log.api.info("GET \(path, privacy: .public) ok in \(milliseconds, privacy: .public)ms")
    return data
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
