import JuniorKit
import Observation
import SwiftUI

/// One Conversation through the public API: `getConversation` for its state
/// and a cursor to follow it, and `listConversationMessages` for history.
@MainActor
@Observable
final class ConversationModel {
  let conversationId: String
  var state: ConversationState?
  var messages: [MCPMessage] = []
  /// `nextCursor` for older messages, when there are any.
  var olderCursor: String?
  var loadingEarlier = false
  var error: JuniorAPIError?
  var actionError: String?
  var sending = false
  var stopping = false
  /// A refresh failed after the page loaded; the page keeps what it has.
  var refreshFailed = false

  /// Follow position: the `cursor` of the newest read.
  private var cursor: String?
  private var refreshing = false
  private var reportedSeq = -1

  init(conversationId: String) {
    self.conversationId = conversationId
  }

  var conversation: MCPConversation? { state?.conversation }

  /// Polls fast while a Turn runs, messages wait, or a parked Turn waits for
  /// the viewer to connect an account.
  var isLive: Bool {
    conversation?.turnActive == true || !(state?.pendingMessages.isEmpty ?? true) || state?.authorization != nil
  }

  /// Pending messages that the transcript does not show yet.
  var queued: [PendingMessage] { unreadPending(state?.pendingMessages ?? [], transcript: messages) }

  private var id: JSONValue { .string(conversationId) }

  /// Open: the state, and the newest page of messages.
  func open(_ app: AppModel) async {
    do {
      async let opened = app.call("getConversation", ["conversationId": id], as: ConversationState.self)
      async let page = app.call(
        "listConversationMessages", ["conversationId": id, "limit": 30], as: MessagePage.self)
      let (state, newest) = try await (opened, page)
      self.state = state
      cursor = state.cursor
      messages = mergeMessages(messages, newest.messages)
      olderCursor = newest.nextCursor
      error = nil
      refreshFailed = false
      rebuild()
      await markRead(app)
    } catch let error as JuniorAPIError {
      if state == nil { self.error = error } else { refreshFailed = true }
    } catch {}
  }

  /// Read what came after the cursor, page by page while `hasMore` is set.
  func refresh(_ app: AppModel) async {
    guard !refreshing else { return }
    guard let start = cursor else { return await open(app) }
    refreshing = true
    defer { refreshing = false }
    var after = start
    do {
      for _ in 0..<5 {
        let next = try await app.call(
          "getConversation", ["conversationId": id, "after": .string(after)], as: ConversationState.self)
        messages = mergeMessages(messages, next.messages ?? [])
        // `brief` and the conversation come with every read.
        state = next
        after = next.cursor
        if next.hasMore != true { break }
      }
      cursor = after
      refreshFailed = false
      rebuild()
      await markRead(app)
    } catch JuniorAPIError.tool {
      // The cursor stopped working (the transcript was replaced); start over.
      cursor = nil
      await open(app)
    } catch {
      refreshFailed = true
    }
  }

  /// "Show earlier messages".
  func loadEarlier(_ app: AppModel) async {
    guard let before = olderCursor, !loadingEarlier else { return }
    loadingEarlier = true
    defer { loadingEarlier = false }
    do {
      let page = try await app.call(
        "listConversationMessages", ["conversationId": id, "before": .string(before), "limit": 30],
        as: MessagePage.self)
      messages = mergeMessages(messages, page.messages)
      olderCursor = page.nextCursor
      rebuild()
    } catch {
      actionError = "Could not load earlier messages."
    }
  }

  /// The page opens at the newest message, so reading it marks it read.
  private func markRead(_ app: AppModel) async {
    guard let newest = messages.last?.seq, newest > reportedSeq else { return }
    struct Read: Decodable, Sendable { var lastReadSeq: Int }
    // A failed report only leaves the Conversation unread elsewhere.
    if let read = try? await app.call(
      "markConversationRead", ["conversationId": id, "lastReadSeq": .number(Double(newest))], as: Read.self)
    {
      reportedSeq = max(reportedSeq, read.lastReadSeq)
    }
  }

  /// Parsed Markdown per message, so polls do not re-parse every row.
  private(set) var messageBlocks: [Int: [MarkdownBlock]] = [:]
  @ObservationIgnored private var parsedByText: [String: [MarkdownBlock]] = [:]

  private func rebuild() {
    var blocks: [Int: [MarkdownBlock]] = [:]
    var kept: [String: [MarkdownBlock]] = [:]
    for message in messages where !message.text.isEmpty {
      let parsed = parsedByText[message.text] ?? parseMarkdown(message.text)
      kept[message.text] = parsed
      blocks[message.seq] = parsed
    }
    parsedByText = kept
    messageBlocks = blocks
  }

  /// The draft's idempotency key. A retry after a timeout reuses it, so
  /// Junior keeps one message; it changes only after a send succeeds.
  private var draftKey = UUID().uuidString

  /// `sendMessage`. `interrupt` joins the running Turn at its next safe step
  /// instead of waiting for it. Returns false when it failed; the composer
  /// keeps the text.
  func send(_ message: String, interrupt: Bool, app: AppModel) async -> Bool {
    sending = true
    defer { sending = false }
    do {
      let accepted = try await app.call(
        "sendMessage",
        [
          "conversationId": id, "message": .string(message), "idempotencyKey": .string(draftKey),
          "delivery": interrupt ? "interrupt" : "defer",
        ], as: AcceptedMessage.self)
      draftKey = UUID().uuidString
      actionError = nil
      if let pending = accepted.pendingMessages { state?.pendingMessages = pending }
      if let authorization = accepted.authorization { state?.authorization = authorization }
      await refresh(app)
      return true
    } catch {
      actionError = (error as? JuniorAPIError)?.localizedDescription ?? "Message failed to send. Try again."
      return false
    }
  }

  /// `stopConversation`: stop the running Turn and drop waiting messages.
  func stop(_ app: AppModel) async {
    struct Stopped: Decodable, Sendable { var status: String }
    stopping = true
    defer { stopping = false }
    do {
      _ = try await app.call("stopConversation", ["conversationId": id], as: Stopped.self)
      await refresh(app)
    } catch {
      actionError = (error as? JuniorAPIError)?.localizedDescription ?? "Could not stop."
    }
  }

  /// `cancelQueuedMessages`: drop waiting messages; the Turn continues.
  func cancelQueued(_ app: AppModel) async {
    struct Cancelled: Decodable, Sendable { var cancelledCount: Int }
    do {
      _ = try await app.call("cancelQueuedMessages", ["conversationId": id], as: Cancelled.self)
      await refresh(app)
    } catch {
      actionError = (error as? JuniorAPIError)?.localizedDescription ?? "Could not cancel."
    }
  }

  /// A write from the menu, then a refresh. Returns false when it failed.
  @discardableResult
  func write<Result: Decodable & Sendable>(
    _ tool: String, _ arguments: [String: JSONValue], as type: Result.Type, app: AppModel
  ) async -> Bool {
    do {
      _ = try await app.call(tool, arguments.merging(["conversationId": id]) { a, _ in a }, as: type)
      actionError = nil
      app.didWrite()
      await refresh(app)
      return true
    } catch {
      actionError = (error as? JuniorAPIError)?.localizedDescription ?? "Could not save."
      return false
    }
  }

  /// The transcript as Markdown, for "Copy as Markdown".
  func markdown(agentName: String) -> String {
    var lines = ["# \(conversation?.title ?? "Conversation")", ""]
    for message in messages {
      lines.append("**\(message.isAssistant ? agentName : message.author ?? "User")**")
      lines.append("")
      lines.append(message.text)
      lines.append("")
    }
    return lines.joined(separator: "\n")
  }
}
