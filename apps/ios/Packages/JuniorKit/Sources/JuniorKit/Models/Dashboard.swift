/// The dashboard API's `/api/config`: the release that the server runs and,
/// on a Vercel deploy, the commit.
public struct ServerConfig: Decodable, Sendable {
  public var version: String
  public var commit: String?

  /// "0.314.0 · 4f2c9a1": the release and the short commit, so two deploys
  /// of one release differ.
  public var versionLabel: String {
    guard let commit else { return version }
    return "\(version) · \(commit.prefix(7))"
  }
}
