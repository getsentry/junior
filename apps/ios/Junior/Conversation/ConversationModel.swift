import JuniorKit
import Observation
import SwiftUI

/// One Conversation: its header facts, events merged by `seq`, queued
/// messages, and the writes its page offers.
@MainActor
@Observable
final class ConversationModel {
  let conversationId: String
  var detail: ConversationDetail?
  var transcript = TranscriptModel(rows: [], responding: false)
  var events: [Int: TranscriptEvent] = [:]
  private var argumentOrder: [String: [String]] = [:]
  var previousCursor: String?
  var loadingEarlier = false
  var error: JuniorAPIError?
  var actionError: String?
  var sending = false
  var stopping = false
  /// A refresh failed after the page loaded; the page keeps what it has.
  var refreshFailed = false

  /// The read position when the Conversation opened. Like the web, it places
  /// the "New" line once and does not move during the visit.
  private(set) var readAtOpen: Int?
  /// The newest event when the Conversation opened; later rows are not "new".
  private(set) var unreadThrough: Int?
  private var seenSeq = -1
  /// Off until the page has scrolled to where it opens; rows laid out on the
  /// way there were not read.
  private(set) var trackingReads = false
  /// Rows on screen now, kept even while reads are not tracked yet.
  @ObservationIgnored private var visibleSeqs = Set<Int>()
  /// The first load has applied; later loads only refresh.
  private var opened = false
  private var reportedSeq = -1
  private var reportTask: Task<Void, Never>?

  init(conversationId: String) {
    self.conversationId = conversationId
  }

  private var path: String { "/api/conversations/\(conversationId.pathEscaped)" }

  /// Polls fast while the agent works, messages wait, or a parked Turn waits
  /// for the viewer to connect an account, like the dashboard.
  var isLive: Bool {
    detail?.status == .active || !(detail?.mailbox?.messages ?? []).isEmpty
      || detail?.mailbox?.authorization != nil
  }

  /// Queued messages not yet in the transcript (history wins on `messageId`).
  var queued: [PendingMessage] {
    let known = Set(
      events.values.compactMap { event -> String? in
        if case .message(let message) = event.data { return message.messageId }
        return nil
      })
    return (detail?.mailbox?.messages ?? []).filter { !known.contains($0.messageId) }
  }

  /// Responses can land out of order when polls and reloads overlap; apply
  /// only one newer than the last applied.
  private var startedLoads = 0
  private var appliedLoad = 0

  /// Load the detail and merge its events. A reader who opens where they
  /// left off gets earlier pages until the first unread event is loaded.
  func load(_ client: JuniorClient, openAtUnread: Bool = false) async {
    startedLoads += 1
    let ticket = startedLoads
    let opening = !opened
    do {
      let (next, data): (ConversationDetail, Data) = try await client.getWithData(
        path, query: [URLQueryItem(name: "mailbox", value: "true")])
      guard ticket > appliedLoad else { return }
      appliedLoad = ticket
      opened = true
      argumentOrder.merge(toolArgumentOrder(in: data)) { _, new in new }
      let newOldest = next.events.map(\.seq).min()
      if opening {
        previousCursor = next.previousCursor
      } else if let newOldest, let known = events.keys.max(), newOldest > known {
        // The new window does not overlap what is loaded (too much happened
        // while away): start from it, and let "Show earlier messages" fill
        // in the rest. Seqs can skip, so only a window past every loaded
        // event counts.
        events = [:]
        previousCursor = next.previousCursor
        historyEpoch += 1
      }
      for event in next.events { events[event.seq] = event }
      if opening {
        readAtOpen = next.readPosition?.lastReadSeq
        unreadThrough = events.keys.max()
        reportedSeq = readAtOpen ?? -1
        // Load back to the first unread event before the page shows, so the
        // "New" line does not move after the reader lands on it.
        if openAtUnread, let read = readAtOpen {
          for _ in 0..<5 {
            guard let oldest = events.keys.min(), oldest > read + 1, previousCursor != nil else { break }
            guard await fetchEarlierPage(client) else { break }
          }
        }
      }
      // A newer load (or a restart) may have applied during the walk; keep
      // its newer detail and only show the pages this walk added.
      guard ticket == appliedLoad, !Task.isCancelled else {
        if detail != nil { rebuild() }
        return
      }
      detail = next
      rebuild()
      error = nil
      refreshFailed = false
    } catch let error as JuniorAPIError {
      if detail == nil { self.error = error } else { refreshFailed = true }
    } catch {}
  }

  /// Bumps when a refresh replaces the loaded window; an earlier page from
  /// before that would leave a hole, so it is dropped.
  private var historyEpoch = 0

  /// "Show earlier messages".
  func loadEarlier(_ client: JuniorClient) async {
    guard !loadingEarlier else { return }
    loadingEarlier = true
    defer { loadingEarlier = false }
    if await fetchEarlierPage(client) {
      rebuild()
    } else if !Task.isCancelled {
      actionError = "Could not load earlier messages."
    }
  }

  /// Merge the page before `previousCursor`. Returns false when it failed.
  private func fetchEarlierPage(_ client: JuniorClient) async -> Bool {
    guard let cursor = previousCursor else { return false }
    let epoch = historyEpoch
    do {
      let (page, data): (TranscriptEventPage, Data) = try await client.getWithData(
        "\(path)/events", query: [URLQueryItem(name: "before", value: cursor)])
      guard epoch == historyEpoch else { return true }
      argumentOrder.merge(toolArgumentOrder(in: data)) { _, new in new }
      for event in page.events { events[event.seq] = event }
      previousCursor = page.previousCursor == cursor ? nil : page.previousCursor
      return true
    } catch {
      return false
    }
  }

  /// The first row that was unread when the Conversation opened.
  var firstUnreadRowId: String? {
    guard let read = readAtOpen, let through = unreadThrough else { return nil }
    return transcript.rows.first { row in
      guard let seq = row.seq else { return false }
      return seq > read && seq <= through
    }?.id
  }

  /// Record that a row reached the screen and report the newest one after a
  /// short pause (`PUT …/read-position`). The server keeps the highest value.
  /// A row came on or went off screen.
  func rowVisibility(_ seq: Int, visible: Bool, client: JuniorClient) {
    if visible {
      visibleSeqs.insert(seq)
      noteSeen(seq, client: client)
    } else {
      visibleSeqs.remove(seq)
    }
  }

  /// Start counting reads once the page sits where it opens, including the
  /// rows already on screen there (their visibility will not change again).
  func startTrackingReads(_ client: JuniorClient) {
    trackingReads = true
    if let newest = visibleSeqs.max() { noteSeen(newest, client: client) }
  }

  func noteSeen(_ seq: Int, client: JuniorClient) {
    guard trackingReads, seq > seenSeq else { return }
    seenSeq = seq
    guard seq > reportedSeq else { return }
    reportTask?.cancel()
    reportTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(750))
      guard let self, !Task.isCancelled else { return }
      struct Body: Encodable { var lastReadSeq: Int }
      let target = self.seenSeq
      // A failed report (offline, read-only token) only costs the "New" line
      // on the next open; the web ignores it too.
      if (try? await client.perform("PUT", "\(self.path)/read-position", body: Body(lastReadSeq: target))) != nil {
        self.reportedSeq = max(self.reportedSeq, target)
      }
    }
  }

  /// Parsed Markdown per message id, so polls do not re-parse every row.
  private(set) var messageBlocks: [String: [MarkdownBlock]] = [:]
  @ObservationIgnored private var parsedByText: [String: [MarkdownBlock]] = [:]

  private func rebuild() {
    guard let detail else { return }
    transcript = buildTranscript(
      events: Array(events.values), status: detail.status, fallbackAuthor: detail.actorIdentity,
      authors: detail.authors ?? [:], argumentOrder: argumentOrder, hasEarlierHistory: previousCursor != nil)
    var blocks: [String: [MarkdownBlock]] = [:]
    var kept: [String: [MarkdownBlock]] = [:]
    for row in transcript.rows {
      guard case .message(let message) = row, !message.text.isEmpty else { continue }
      let parsed = parsedByText[message.text] ?? parseMarkdown(message.text)
      kept[message.text] = parsed
      blocks[message.id] = parsed
    }
    parsedByText = kept
    messageBlocks = blocks
  }

  /// The draft's idempotency key. A retry after a timeout reuses it, so the
  /// server keeps one message; it changes only after a send succeeds.
  private var draftKey = UUID().uuidString

  /// Upload the files, then `POST …/messages`. Returns false when it failed;
  /// the composer keeps the text and the files.
  func send(_ message: String, files: [PendingUpload], client: JuniorClient) async -> Bool {
    struct Body: Encodable {
      var idempotencyKey: String
      var message: String
      var uploadIds: [String]?
    }
    sending = true
    defer { sending = false }
    do {
      let uploads = try await uploadFiles(
        files, messageKey: draftKey, conversationId: conversationId, client: client)
      try await client.perform(
        "POST", "\(path)/messages",
        body: Body(idempotencyKey: draftKey, message: message, uploadIds: uploads.isEmpty ? nil : uploads))
      draftKey = UUID().uuidString
      actionError = nil
      await load(client)
      return true
    } catch let failure as JuniorAPIError where failure == .readOnlyToken {
      actionError = failure.localizedDescription
    } catch let failure as JuniorAPIError {
      actionError = failure.localizedDescription
    } catch {
      actionError = "Message failed to send. Try again."
    }
    return false
  }

  /// `POST …/stop`; returns the texts of stopped messages for the composer.
  func stop(_ client: JuniorClient) async -> [String] {
    struct Stopped: Decodable {
      struct Message: Decodable { var text: String? }
      var stoppedMessages: [Message]?
    }
    stopping = true
    defer { stopping = false }
    do {
      let stopped: Stopped = try await client.send("POST", "\(path)/stop", body: [String: String]())
      await load(client)
      return stopped.stoppedMessages?.compactMap(\.text) ?? []
    } catch {
      actionError = (error as? JuniorAPIError)?.localizedDescription ?? "Could not stop."
      return []
    }
  }

  /// A small write from the overflow menu, then reload.
  func patch<Body: Encodable & Sendable>(_ suffix: String, _ body: Body, client: JuniorClient) async {
    do {
      try await client.perform("PATCH", "\(path)/\(suffix)", body: body)
      actionError = nil
      await load(client)
    } catch {
      actionError = (error as? JuniorAPIError)?.localizedDescription ?? "Could not save."
    }
  }

  /// The transcript as Markdown, for "Copy as Markdown".
  var markdown: String {
    var lines = ["# \(detail?.title ?? "Conversation")", ""]
    for row in transcript.rows {
      guard case .message(let message) = row else { continue }
      let name: String =
        switch message.speaker {
        case .agent: "Junior"
        case .person(let identity): identity?.displayName ?? "User"
        case .parentAgent: "Parent agent"
        case .system: "System"
        case .event(let type): type.contains("automation") ? "Automation" : "Event"
        }
      lines.append("**\(name)**")
      lines.append("")
      lines.append(message.text)
      lines.append("")
    }
    return lines.joined(separator: "\n")
  }
}
