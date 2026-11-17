import Foundation

/// Where the app reads Junior from: the dashboard origin and an optional
/// personal token (`jr_pat_…`). Without a token the request carries no
/// credentials, which works against a local dashboard with auth off.
public struct JuniorServer: Equatable, Sendable, Codable {
  public var baseURL: URL
  public var token: String?

  public init(baseURL: URL, token: String? = nil) {
    self.baseURL = baseURL
    self.token = token?.isEmpty == true ? nil : token
  }
}

/// A failed dashboard API call, in terms the UI can show.
public enum JuniorAPIError: Error, Equatable, Sendable, LocalizedError {
  case signedOut
  case forbidden
  /// Personal tokens authorize only reads; the dashboard rejects writes made
  /// with one.
  case readOnlyToken
  case notFound
  case server(status: Int, message: String?)
  case decoding(String)
  case offline(String)

  public var errorDescription: String? {
    switch self {
    case .signedOut: "Your token is missing or expired. Add a new one in Settings."
    case .forbidden: "Your account cannot use this Junior."
    case .readOnlyToken: "Personal tokens are read-only. Send this from the web dashboard."
    case .notFound: "This was deleted or you no longer have access."
    case .server(_, let message?): message
    case .server(let status, nil): "Junior returned an error (\(status))."
    case .decoding(let detail): "Junior sent data this app cannot read. \(detail)"
    case .offline(let detail): "Could not reach Junior. \(detail)"
    }
  }
}

/// Client for the dashboard's product API (`/api/*`).
public struct JuniorClient: Sendable {
  public let server: JuniorServer
  private let session: URLSession

  public init(server: JuniorServer, session: URLSession = .shared) {
    self.server = server
    self.session = session
  }

  /// GET a JSON resource.
  public func get<Response: Decodable>(
    _ path: String, query: [URLQueryItem] = [], as type: Response.Type = Response.self
  ) async throws -> Response {
    try await request("GET", path, query: query, body: Optional<Empty>.none)
  }

  /// GET a JSON resource and also return its raw bytes, for readers that need
  /// what `JSONDecoder` drops (object key order).
  public func getWithData<Response: Decodable>(
    _ path: String, query: [URLQueryItem] = [], as type: Response.Type = Response.self
  ) async throws -> (Response, Data) {
    let raw: RawData = try await request("GET", path, query: query, body: Optional<Empty>.none)
    do {
      return (try JSONDecoder.junior.decode(Response.self, from: raw.data), raw.data)
    } catch {
      throw JuniorAPIError.decoding(Self.describe(error))
    }
  }

  /// Send a JSON body with a write method and decode the JSON response.
  public func send<Body: Encodable & Sendable, Response: Decodable>(
    _ method: String, _ path: String, body: Body?, as type: Response.Type = Response.self
  ) async throws -> Response {
    try await request(method, path, query: [], body: body)
  }

  /// Send a write whose response body the caller does not need.
  public func perform<Body: Encodable & Sendable>(_ method: String, _ path: String, body: Body?) async throws {
    let _: Ignored = try await request(method, path, query: [], body: body)
  }

  private func request<Body: Encodable & Sendable, Response: Decodable>(
    _ method: String, _ path: String, query: [URLQueryItem], body: Body?
  ) async throws -> Response {
    // Callers escape path segments (`encodeURIComponent` style), so join
    // strings instead of `appending(path:)`, which would escape them again.
    var base = server.baseURL.absoluteString
    if base.hasSuffix("/") { base.removeLast() }
    guard var components = URLComponents(string: base + path) else {
      throw JuniorAPIError.server(status: 0, message: "Invalid path \(path)")
    }
    if !query.isEmpty {
      components.queryItems = (components.queryItems ?? []) + query
    }
    guard let url = components.url else {
      throw JuniorAPIError.server(status: 0, message: "Invalid path \(path)")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let token = server.token {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(body)
    }

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch let error as URLError where error.code == .cancelled {
      throw CancellationError()
    } catch {
      throw JuniorAPIError.offline(error.localizedDescription)
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      throw Self.error(status: status, method: method, hasToken: server.token != nil, data: data)
    }
    if Response.self == Ignored.self { return Ignored() as! Response }
    if Response.self == RawData.self { return RawData(data: data) as! Response }
    do {
      return try JSONDecoder.junior.decode(Response.self, from: data)
    } catch {
      throw JuniorAPIError.decoding(Self.describe(error))
    }
  }

  static func error(status: Int, method: String, hasToken: Bool, data: Data) -> JuniorAPIError {
    if status == 401, hasToken, method != "GET" { return .readOnlyToken }
    switch status {
    case 401: return .signedOut
    case 403: return .forbidden
    case 404: return .notFound
    default:
      let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
      return .server(status: status, message: body?.error ?? body?.message)
    }
  }

  static func describe(_ error: Error) -> String {
    guard let error = error as? DecodingError else { return error.localizedDescription }
    switch error {
    case .keyNotFound(let key, let context):
      return "Missing \(path(context.codingPath + [key]))."
    case .typeMismatch(_, let context), .valueNotFound(_, let context), .dataCorrupted(let context):
      return "Unexpected value at \(path(context.codingPath))."
    @unknown default:
      return error.localizedDescription
    }
  }

  private static func path(_ keys: [CodingKey]) -> String {
    keys.map { $0.intValue.map { "[\($0)]" } ?? ".\($0.stringValue)" }.joined()
  }
}

private struct Empty: Encodable {}
private struct Ignored: Decodable {}
private struct RawData: Decodable {
  var data: Data
  init(data: Data) { self.data = data }
  init(from decoder: Decoder) throws { data = Data() }
}
private struct ErrorBody: Decodable {
  var error: String?
  var message: String?
}

extension JSONDecoder {
  /// Decoder for dashboard JSON: ISO 8601 dates with or without fractions.
  public static var junior: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      let text = try container.decode(String.self)
      if let date = Date.junior(text) { return date }
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Bad date \(text)")
    }
    return decoder
  }
}

extension Date {
  /// Parse a dashboard timestamp (`2026-08-07T11:54:22.000Z`).
  public static func junior(_ text: String) -> Date? {
    let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    let whole = Date.ISO8601FormatStyle()
    return (try? fractional.parse(text)) ?? (try? whole.parse(text))
  }
}
