import Foundation

/// The Junior this app talks to. Its public API is the MCP server at
/// `/api/mcp`; the rest of the origin belongs to the web dashboard.
public struct JuniorServer: Equatable, Sendable, Codable {
  public var baseURL: URL

  public init(baseURL: URL) { self.baseURL = baseURL }

  /// The MCP endpoint, which is also the OAuth resource indicator.
  public var mcpURL: URL { URL(string: "/api/mcp", relativeTo: baseURL)!.absoluteURL }

  /// A dashboard page, for what the app opens on the web.
  public func page(_ path: String) -> URL? { URL(string: path, relativeTo: baseURL)?.absoluteURL }
}

/// A failed call, in terms the UI can show.
public enum JuniorAPIError: Error, Equatable, Sendable, LocalizedError {
  /// No sign-in, or Junior ended it (expired, revoked, or the domain was removed).
  case signedOut
  case signIn(String)
  /// A tool refused the call, such as an unknown Conversation or a stale archive.
  case tool(String)
  case server(status: Int, message: String?)
  case decoding(String)
  case offline(String)

  public var errorDescription: String? {
    switch self {
    case .signedOut: "Sign in to Junior again."
    case .signIn(let detail): "Could not sign in. \(detail)"
    case .tool(let message): message
    case .server(_, let message?): message
    case .server(let status, nil): "Junior returned an error (\(status))."
    case .decoding(let detail): "Junior sent data this app cannot read. \(detail)"
    case .offline(let detail): "Could not reach Junior. \(detail)"
    }
  }
}

extension JSONDecoder {
  /// ISO 8601 dates with or without fractional seconds.
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
  public static func junior(_ text: String) -> Date? {
    let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    let whole = Date.ISO8601FormatStyle()
    return (try? fractional.parse(text)) ?? (try? whole.parse(text))
  }
}

func describe(_ error: DecodingError) -> String {
  switch error {
  case .keyNotFound(let key, let context):
    return "Missing \(path(context.codingPath + [key]))."
  case .typeMismatch(_, let context), .valueNotFound(_, let context), .dataCorrupted(let context):
    return "Bad value at \(path(context.codingPath))."
  @unknown default:
    return "\(error)"
  }
}

private func path(_ keys: [CodingKey]) -> String {
  keys.map { $0.intValue.map { "[\($0)]" } ?? ".\($0.stringValue)" }.joined().trimmingCharacters(in: ["."])
}
