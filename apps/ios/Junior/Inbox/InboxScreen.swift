import JuniorKit
import SwiftUI

/// Shared Inbox data: open items and the titles of the Conversations that
/// added them.
@MainActor
@Observable
final class InboxModel {
  var items: [ReviewItem] = []
  var sourceTitles: [String: String] = [:]
  var loading = false
  var error: JuniorAPIError?
  var query = ""

  var nextCursor: String?
  var loadingMore = false
  private var startedLoads = 0
  private var appliedLoad = 0

  var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

  private func params(cursor: String?) -> [URLQueryItem] {
    var query = [URLQueryItem(name: "for", value: "viewer")]
    let trimmed = self.query.trimmingCharacters(in: .whitespaces)
    if !trimmed.isEmpty { query.append(URLQueryItem(name: "q", value: trimmed)) }
    if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
    return query
  }

  /// Load the first page; out-of-order responses (an older search) are dropped.
  func load(_ client: JuniorClient) async {
    startedLoads += 1
    let ticket = startedLoads
    loading = items.isEmpty
    defer { loading = false }
    do {
      let page: ReviewItemPage = try await client.get("/api/review-items", query: params(cursor: nil))
      guard ticket > appliedLoad else { return }
      appliedLoad = ticket
      items = page.items
      nextCursor = page.nextCursor
      error = nil
      await loadSourceTitles(client)
    } catch let error as JuniorAPIError {
      self.error = error
    } catch {}
  }

  /// The next page, from the "Load more" button (pages hold 50 items).
  func loadMore(_ client: JuniorClient) async {
    guard let cursor = nextCursor, !loadingMore else { return }
    loadingMore = true
    defer { loadingMore = false }
    guard let page: ReviewItemPage = try? await client.get("/api/review-items", query: params(cursor: cursor))
    else { return }
    let known = Set(items.map(\.id))
    items += page.items.filter { !known.contains($0.id) }
    nextCursor = page.nextCursor
    await loadSourceTitles(client)
  }

  /// Title of each source Conversation, read once (`?limit=1`).
  func loadSourceTitles(_ client: JuniorClient) async {
    let ids = Set(items.compactMap(\.addedByConversationId)).subtracting(sourceTitles.keys)
    await withTaskGroup(of: (String, String?).self) { group in
      for id in ids {
        group.addTask {
          struct Header: Decodable { var displayTitle: String? }
          let header: Header? = try? await client.get(
            "/api/conversations/\(id.pathEscaped)", query: [URLQueryItem(name: "limit", value: "1")])
          return (id, header?.displayTitle)
        }
      }
      for await (id, title) in group {
        if let title { sourceTitles[id] = title }
      }
    }
  }

  func source(of item: ReviewItem) -> String {
    if item.automationId != nil { return "Automation" }
    return item.addedByConversationId.flatMap { sourceTitles[$0] } ?? "Conversation"
  }

  /// The next open item after this one, in Inbox order.
  func next(after id: String) -> ReviewItem? {
    let ordered = inboxGroups(items).flatMap(\.items)
    guard let index = ordered.firstIndex(where: { $0.id == id }) else { return ordered.first }
    return ordered.dropFirst(index + 1).first
  }
}

/// Route `/review`: open Review items grouped as Needs you and FYI.
struct InboxScreen: View {
  @Environment(AppModel.self) private var app
  @Environment(InboxModel.self) private var model
  @State private var collapsed: Set<String> = []

  var body: some View {
    @Bindable var model = model
    VStack(spacing: 0) {
      AppHeader(title: app.agentName)
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          Text("Inbox")
            .type(.lg, .medium, family: .display)
            .foregroundStyle(Tokens.text)
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 12)
            .accessibilityAddTraits(.isHeader)
          SearchField(placeholder: "Search items…", text: $model.query)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
          list.padding(.horizontal, 12)
        }
      }
      .refreshable { await model.load(app.client) }
    }
    .background(Tokens.surfacePanel)
    .toolbar(.hidden, for: .navigationBar)
    .task(id: app.reviewItemsVersion) { await model.load(app.client) }
    .task(id: model.query) {
      try? await Task.sleep(for: .milliseconds(250))
      if !Task.isCancelled { await model.load(app.client) }
    }
  }

  @ViewBuilder private var list: some View {
    if model.loading {
      VStack(alignment: .leading, spacing: 14) {
        ForEach(0..<4, id: \.self) { _ in
          VStack(alignment: .leading, spacing: 6) {
            Skeleton(width: 220, height: 14)
            Skeleton(width: 180, height: 12)
          }
          .padding(.leading, 34)
        }
      }
      .padding(.top, 12)
    } else if let error = model.error, model.items.isEmpty {
      EmptyBox(text: error.localizedDescription) { Task { await model.load(app.client) } }
    } else {
      // A search lists every match: open items first, then closed ones.
      let groups =
        model.searching
        ? [
          (id: "results", title: "Results", items: model.items.filter(\.isOpen) + model.items.filter { !$0.isOpen })
        ].filter { !$0.items.isEmpty }
        : inboxGroups(model.items)
      if groups.isEmpty {
        Text(model.searching ? "No items match" : "Nothing needs you")
          .type(.lg, .medium, family: .display)
          .foregroundStyle(Tokens.textMuted)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 48)
      }
      ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
        let binding = Binding(
          get: { collapsed.contains(group.id) },
          set: { if $0 { collapsed.insert(group.id) } else { collapsed.remove(group.id) } })
        SectionHeading(title: group.title, count: group.items.count, collapsed: binding)
          .padding(.top, index == 0 ? 0 : 8)
        if !binding.wrappedValue {
          VStack(spacing: 2) {
            ForEach(group.items) { item in
              InboxRow(item: item, source: model.source(of: item))
            }
          }
        }
      }
      if model.nextCursor != nil {
        Button(model.loadingMore ? "Loading…" : "Load more") { Task { await model.loadMore(app.client) } }
          .buttonStyle(.dashboard(.ghost))
          .disabled(model.loadingMore)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 8)
      }
    }
  }
}

private struct InboxRow: View {
  @Environment(AppModel.self) private var app
  let item: ReviewItem
  let source: String

  var body: some View {
    Button {
      app.path.append(.reviewItem(item.id))
    } label: {
      HStack(alignment: .top, spacing: 8) {
        dot.frame(width: 14).padding(.top, 6)
        VStack(alignment: .leading, spacing: 4) {
          Text(item.title)
            .type(.sm, .medium)
            .foregroundStyle(item.isOpen ? Tokens.text : Tokens.textMuted)
            .lineLimit(1)
          Text(subtitle)
            .type(.xs)
            .foregroundStyle(Tokens.textMuted)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle())
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("inbox-row")
  }

  private var subtitle: String {
    var parts: [String] = []
    if !item.isOpen { parts.append(item.statusLabel) }
    parts.append(source)
    if let date = item.isOpen ? item.createdAt : (item.closedAt ?? item.createdAt) {
      parts.append(app.clock.relative(date))
    }
    return parts.joined(separator: " · ")
  }

  @ViewBuilder private var dot: some View {
    if !item.isOpen {
      Circle().strokeBorder(Tokens.textFaint, lineWidth: 1).frame(width: 8, height: 8)
    } else {
      Dot(color: item.kind == .notice ? Tokens.textFaint : Tokens.accent, size: 8)
    }
  }
}
