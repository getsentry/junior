/// The people who wrote in one Conversation: `authors` from the dashboard
/// API's Conversation detail.
public struct ConversationAuthors: Decodable, Sendable {
  public struct Author: Decodable, Sendable {
    /// Dashboard API path of the profile photo.
    public var avatarUrl: String?
    public var email: String?
    public var fullName: String?
    public var slackUserName: String?
  }

  public var authors: [String: Author]?

  /// Profile photo paths by the name that an MCP message shows as `author`:
  /// the full name, then the Slack name, then the email.
  public var photos: [String: String] {
    var photos: [String: String] = [:]
    for author in (authors ?? [:]).values {
      if let name = author.fullName ?? author.slackUserName ?? author.email, let path = author.avatarUrl {
        photos[name] = path
      }
    }
    return photos
  }
}
