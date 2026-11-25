/// The dashboard API's `/api/inbox-items/count`: the counts behind the
/// dashboard's Inbox badge.
public struct InboxItemCount: Decodable, Sendable {
  /// Open action items that wait on the viewer, as the server's
  /// `inboxItemNeedsUser` rule counts them.
  public var needsViewer: Int
}
