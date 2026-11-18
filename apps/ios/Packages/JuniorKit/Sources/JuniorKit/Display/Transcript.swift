import Foundation

/// Merge pages of messages into one transcript, oldest first. Pages overlap
/// when a follow-up read starts at an earlier cursor; a later copy wins.
public func mergeMessages(_ current: [MCPMessage], _ incoming: [MCPMessage]) -> [MCPMessage] {
  var bySeq = Dictionary(current.map { ($0.seq, $0) }, uniquingKeysWith: { _, new in new })
  for message in incoming { bySeq[message.seq] = message }
  return bySeq.values.sorted { $0.seq < $1.seq }
}

/// Pending messages that the transcript does not show yet. A Turn that reads
/// a pending message adds it to the transcript with the same `messageId`.
public func unreadPending(_ pending: [PendingMessage], transcript: [MCPMessage]) -> [PendingMessage] {
  let shown = Set(transcript.map(\.messageId))
  return pending.filter { !shown.contains($0.messageId) }
}
