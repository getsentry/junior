import Foundation

/// Merge pages of messages or activity, identified by seq, into one
/// transcript, oldest first. Pages overlap when a follow-up read starts at an
/// earlier cursor; a later copy wins.
public func mergeBySeq<Item: Identifiable>(_ current: [Item], _ incoming: [Item]) -> [Item] where Item.ID == Int {
  var bySeq = Dictionary(current.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
  for item in incoming { bySeq[item.id] = item }
  return bySeq.values.sorted { $0.id < $1.id }
}

/// Pending messages that the transcript does not show yet. A Turn that reads
/// a pending message adds it to the transcript with the same `messageId`.
public func unreadPending(_ pending: [PendingMessage], transcript: [MCPMessage]) -> [PendingMessage] {
  let shown = Set(transcript.map(\.messageId))
  return pending.filter { !shown.contains($0.messageId) }
}
