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

  init(conversationId: String) {
    self.conversationId = conversationId
  }

  private var path: String { "/api/conversations/\(conversationId.pathEscaped)" }

  /// Polls fast while the agent works or messages wait, like the dashboard.
  var isLive: Bool {
    detail?.status == .active || !(detail?.mailbox?.messages ?? []).isEmpty
  }

  var queued: [PendingMessage] { detail?.mailbox?.messages ?? [] }

  func load(_ client: JuniorClient) async {
    do {
      let (next, data): (ConversationDetail, Data) = try await client.getWithData(
        path, query: [URLQueryItem(name: "mailbox", value: "true")])
      argumentOrder.merge(toolArgumentOrder(in: data)) { _, new in new }
      if detail == nil || previousCursor == nil { previousCursor = next.previousCursor }
      for event in next.events { events[event.seq] = event }
      detail = next
      rebuild()
      error = nil
    } catch let error as JuniorAPIError {
      if detail == nil { self.error = error }
    } catch {}
  }

  func loadEarlier(_ client: JuniorClient) async {
    guard let cursor = previousCursor, !loadingEarlier else { return }
    loadingEarlier = true
    defer { loadingEarlier = false }
    do {
      let (page, data): (TranscriptEventPage, Data) = try await client.getWithData(
        "\(path)/events", query: [URLQueryItem(name: "before", value: cursor)])
      argumentOrder.merge(toolArgumentOrder(in: data)) { _, new in new }
      for event in page.events { events[event.seq] = event }
      previousCursor = page.previousCursor == cursor ? nil : page.previousCursor
      rebuild()
    } catch {
      actionError = "Could not load earlier messages."
    }
  }

  private func rebuild() {
    guard let detail else { return }
    transcript = buildTranscript(
      events: Array(events.values), status: detail.status, fallbackAuthor: detail.actorIdentity,
      authors: detail.authors ?? [:], argumentOrder: argumentOrder)
  }

  /// `POST …/messages`; returns false when the send failed.
  func send(_ message: String, uploads: [String], client: JuniorClient) async -> Bool {
    struct Body: Encodable {
      var idempotencyKey: String
      var message: String
      var uploadIds: [String]?
    }
    sending = true
    defer { sending = false }
    do {
      try await client.perform(
        "POST", "\(path)/messages",
        body: Body(idempotencyKey: UUID().uuidString, message: message, uploadIds: uploads.isEmpty ? nil : uploads))
      actionError = nil
      await load(client)
      return true
    } catch let failure as JuniorAPIError where failure == .readOnlyToken {
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
        }
      lines.append("**\(name)**")
      lines.append("")
      lines.append(message.text)
      lines.append("")
    }
    return lines.joined(separator: "\n")
  }
}
