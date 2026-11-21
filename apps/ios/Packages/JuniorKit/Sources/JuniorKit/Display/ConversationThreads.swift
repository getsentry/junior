import Foundation

/// One Thread row under a home row, with its depth under the root.
public struct ThreadRow: Identifiable, Equatable, Sendable {
  public var conversation: MCPConversation
  /// 0 for a Thread directly under the root.
  public var depth: Int

  public var id: String { conversation.conversationId }

  /// Indent steps. Deep trees stop stepping in, so titles keep their width,
  /// as the dashboard's `DEPTH_INDENT` does.
  public var indent: Int { min(depth, 2) }
}

/// The Thread rows that show under one root, and its "Show N more" toggle.
public struct ThreadRows: Equatable, Sendable {
  public var rows: [ThreadRow]
  /// The root has more direct Threads than show while collapsed.
  public var collapsible: Bool
  /// Rows that the collapsed list leaves out, nested ones included.
  public var hiddenCount: Int
}

/// Direct Threads that show under a root before "Show N more".
let collapsedThreadLimit = 3

/// Pick the Threads that show under one root, like the dashboard's
/// `sidebarThreads.ts`. Rows keep the server's order, depth first. A collapsed
/// root shows its direct Threads with the newest activity, plus the direct
/// Thread that holds the open one. A nested Thread shows only under its shown
/// parent, so a row never sits under an unrelated Thread.
public func threadRows(_ threads: [MCPConversation]?, expanded: Bool, selectedId: String? = nil) -> ThreadRows {
  let direct = threads ?? []
  let all = flatten(direct, depth: 0)
  let collapsible = direct.count > collapsedThreadLimit
  guard collapsible, !expanded else {
    return ThreadRows(rows: all, collapsible: collapsible, hiddenCount: 0)
  }
  // Ties keep the server's order, as the web's stable sort does.
  var shownIds = Set(
    direct.enumerated()
      .sorted { lhs, rhs in
        let l = lhs.element.lastSeenAt.date ?? .distantPast
        let r = rhs.element.lastSeenAt.date ?? .distantPast
        return l != r ? l > r : lhs.offset < rhs.offset
      }
      .prefix(collapsedThreadLimit)
      .map(\.element.conversationId))
  if let selectedId, let open = direct.first(where: { holds($0, selectedId) }) {
    shownIds.insert(open.conversationId)
  }
  let shown = flatten(direct.filter { shownIds.contains($0.conversationId) }, depth: 0)
  return ThreadRows(rows: shown, collapsible: true, hiddenCount: all.count - shown.count)
}

private func holds(_ conversation: MCPConversation, _ id: String) -> Bool {
  conversation.conversationId == id || (conversation.threads ?? []).contains { holds($0, id) }
}

private func flatten(_ threads: [MCPConversation], depth: Int) -> [ThreadRow] {
  threads.flatMap { [ThreadRow(conversation: $0, depth: depth)] + flatten($0.threads ?? [], depth: depth + 1) }
}
