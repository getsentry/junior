import JuniorKit
import Observation
import SwiftUI

/// The home list: feed pages, the waiting map that builds "Needs you", and
/// the search query.
@MainActor
@Observable
final class HomeModel {
  var rows: [ConversationSummary] = []
  var waiting: [String: Date?] = [:]
  var nextCursor: String?
  var loading = false
  var loadingMore = false
  var loadMoreFailed = false
  var error: JuniorAPIError?
  var query = ""
  var collapsed: Set<String> {
    didSet { UserDefaults.standard.set(Array(collapsed), forKey: "collapsedSections") }
  }

  init() {
    collapsed = Set(UserDefaults.standard.stringArray(forKey: "collapsedSections") ?? [])
  }

  func sections(clock: DisplayClock) -> [ConversationSection] {
    let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
    let visible = searching ? rows : rows.filter { $0.archivedAt == nil }
    return conversationSections(visible, waiting: waiting, clock: clock)
  }

  /// Load the first page (and refresh the waiting map) for the current query.
  func load(_ client: JuniorClient) async {
    loading = rows.isEmpty
    defer { loading = false }
    let trimmed = String(query.trimmingCharacters(in: .whitespaces).prefix(200))
    let query = trimmed.isEmpty ? [] : [URLQueryItem(name: "q", value: trimmed)]
    do {
      async let feed: ConversationFeed = client.get("/api/conversations", query: query)
      async let waiting: WaitingConversations? = try? client.get("/api/review-items/waiting-conversations")
      let page = try await feed
      rows = page.conversations
      nextCursor = page.nextCursor
      if let waiting = await waiting {
        self.waiting = Dictionary(
          waiting.conversations.map { ($0.conversationId, $0.waitingSince) }, uniquingKeysWith: { a, _ in a })
      }
      error = nil
      loadMoreFailed = false
    } catch let error as JuniorAPIError {
      self.error = error
    } catch {}
  }

  func loadMore(_ client: JuniorClient) async {
    guard let cursor = nextCursor, !loadingMore else { return }
    loadingMore = true
    defer { loadingMore = false }
    var query = [URLQueryItem(name: "cursor", value: cursor)]
    let trimmed = self.query.trimmingCharacters(in: .whitespaces)
    if !trimmed.isEmpty { query.append(URLQueryItem(name: "q", value: trimmed)) }
    do {
      let page: ConversationFeed = try await client.get("/api/conversations", query: query)
      let known = Set(rows.map(\.conversationId))
      rows += page.conversations.filter { !known.contains($0.conversationId) }
      nextCursor = page.nextCursor
      loadMoreFailed = false
    } catch {
      loadMoreFailed = true
    }
  }

  /// Archive or restore one row, optimistically.
  func setArchived(_ row: ConversationSummary, archived: Bool, client: JuniorClient) async throws {
    let index = rows.firstIndex { $0.conversationId == row.conversationId }
    if let index { rows[index].archivedAt = archived ? Date() : nil }
    struct Body: Encodable {
      var archived: Bool
      var lastSeenAt: String?
      var applyToChildren = true
    }
    do {
      try await client.perform(
        "PATCH", "/api/conversations/\(row.conversationId.pathEscaped)/archive",
        body: Body(archived: archived, lastSeenAt: row.lastSeenAt.map { $0.ISO8601Format() }))
    } catch {
      if let index { rows[index].archivedAt = row.archivedAt }
      throw error
    }
  }
}

extension String {
  /// Escape for one URL path segment, like `encodeURIComponent`.
  var pathEscaped: String {
    addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? self
  }
}
