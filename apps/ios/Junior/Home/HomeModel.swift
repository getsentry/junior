import JuniorKit
import Observation
import SwiftUI

/// The home list (`searchConversations`): up to 50 Conversations, newest
/// activity first, each with its Threads, and the search query.
@MainActor
@Observable
final class HomeModel {
  var rows: [MCPConversation] = []
  var loading = false
  var error: JuniorAPIError?
  var query = ""
  var collapsed: Set<String> {
    didSet { UserDefaults.standard.set(Array(collapsed), forKey: "collapsedSections") }
  }
  /// Roots that show all their Threads. Like the dashboard, this resets.
  var expandedThreads: Set<String> = []

  init() {
    collapsed = Set(UserDefaults.standard.stringArray(forKey: "collapsedSections") ?? [])
  }

  func sections(clock: DisplayClock) -> [ConversationSection] {
    let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
    let visible = searching ? rows : rows.filter { $0.archivedAt == nil }
    return conversationSections(visible, clock: clock)
  }

  /// A load started for an older query or tick can finish last; apply only
  /// responses newer than the last applied one.
  private var startedLoads = 0
  private var appliedLoad = 0

  /// Load the list for the current query. A search also finds archived ones.
  func load(_ app: AppModel) async {
    startedLoads += 1
    let ticket = startedLoads
    loading = rows.isEmpty
    defer { loading = false }
    let trimmed = String(query.trimmingCharacters(in: .whitespaces).prefix(200))
    do {
      var arguments: [String: JSONValue] = ["includeThreads": true]
      if !trimmed.isEmpty { arguments["q"] = .string(trimmed) }
      let list = try await app.call("searchConversations", arguments, as: ConversationList.self)
      guard ticket > appliedLoad else { return }
      appliedLoad = ticket
      rows = list.conversations
      error = nil
    } catch let error as JuniorAPIError {
      self.error = error
    } catch {}
  }

  /// A refresh failed while rows show; the list keeps them.
  var refreshFailed: Bool { error != nil && !rows.isEmpty }

  /// Archive or restore one row, optimistically. On failure the row goes
  /// back to how it was, found again by id since a load may have replaced
  /// the list meanwhile.
  func setArchived(_ row: MCPConversation, archived: Bool, app: AppModel) async throws {
    let before = rows.first { $0.conversationId == row.conversationId }?.archivedAt
    update(row.conversationId) { $0.archivedAt = archived ? Timestamp(raw: Date.now.ISO8601Format()) : nil }
    struct Archived: Decodable, Sendable { var archivedAt: Timestamp? }
    do {
      // `lastSeenAt` is the exact text from the server; archive compares it to
      // the millisecond and fails when the Conversation has newer activity.
      _ = try await app.call(
        "archiveConversation",
        [
          "conversationId": .string(row.conversationId), "archived": .bool(archived),
          "lastSeenAt": .string(row.lastSeenAt.raw), "applyToChildren": true,
        ], as: Archived.self)
    } catch {
      update(row.conversationId) { $0.archivedAt = before }
      throw error
    }
  }

  func setPinned(_ row: MCPConversation, pinned: Bool, app: AppModel) async throws {
    struct Pinned: Decodable, Sendable { var pinnedAt: Timestamp? }
    let result = try await app.call(
      "pinConversation", ["conversationId": .string(row.conversationId), "pinned": .bool(pinned)], as: Pinned.self)
    update(row.conversationId) { $0.pinnedAt = result.pinnedAt }
  }

  func rename(_ row: MCPConversation, title: String, app: AppModel) async throws {
    struct Renamed: Decodable, Sendable { var title: String }
    let result = try await app.call(
      "renameConversation", ["conversationId": .string(row.conversationId), "title": .string(title)], as: Renamed.self)
    update(row.conversationId) { $0.title = result.title }
    app.didRename(SavedTitle(conversationId: row.conversationId, title: result.title))
  }

  private func update(_ id: String, _ change: (inout MCPConversation) -> Void) {
    if let index = rows.firstIndex(where: { $0.conversationId == id }) { change(&rows[index]) }
  }
}
