import JuniorKit
import SwiftUI

/// Shared Inbox data (`searchInboxItems`): open Inbox items, 50 at most.
@MainActor
@Observable
final class InboxModel {
  var items: [InboxItem] = []
  /// More items match than the list holds.
  var truncated = false
  var loading = false
  var error: JuniorAPIError?
  var query = ""

  private var startedLoads = 0
  private var appliedLoad = 0

  var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

  /// Load the list; out-of-order responses (an older search) are dropped.
  func load(_ app: AppModel) async {
    startedLoads += 1
    let ticket = startedLoads
    loading = items.isEmpty
    defer { loading = false }
    var arguments: [String: JSONValue] = ["limit": 50]
    let trimmed = String(query.trimmingCharacters(in: .whitespaces).prefix(200))
    if !trimmed.isEmpty { arguments["q"] = .string(trimmed) }
    do {
      let list = try await app.call("searchInboxItems", arguments, as: InboxItemList.self)
      guard ticket > appliedLoad else { return }
      appliedLoad = ticket
      items = list.items
      truncated = list.truncated
      error = nil
    } catch let error as JuniorAPIError {
      self.error = error
    } catch {}
  }

  /// "Needs you" (the items that the badge counts) and "FYI", newest first.
  var groups: [(id: String, title: String, items: [InboxItem])] {
    let newest = items.sorted { ($0.createdAt.date ?? .distantPast) > ($1.createdAt.date ?? .distantPast) }
    let needsYou = newest.filter(\.needsViewer)
    let fyi = newest.filter { !$0.needsViewer }
    return [("needs-you", "Needs you", needsYou), ("fyi", "FYI", fyi)].filter { !$0.items.isEmpty }
  }

  /// The next item after this one, in Inbox order.
  func next(after id: String) -> InboxItem? {
    let ordered = groups.flatMap(\.items)
    guard let index = ordered.firstIndex(where: { $0.id == id }) else { return ordered.first }
    return ordered.dropFirst(index + 1).first
  }
}

/// Route `/inbox`: open Inbox items grouped as Needs you and FYI.
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
      .refreshable { await model.load(app) }
    }
    .background(Tokens.surfacePanel)
    .toolbar(.hidden, for: .navigationBar)
    .task(id: app.inboxItemsVersion) { await model.load(app) }
    .task(id: model.query) {
      try? await Task.sleep(for: .milliseconds(250))
      if !Task.isCancelled { await model.load(app) }
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
      EmptyBox(text: error.localizedDescription) { Task { await model.load(app) } }
    } else {
      let groups = model.groups
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
              InboxRow(item: item)
            }
          }
        }
      }
      if model.error != nil, !model.items.isEmpty {
        Text("Could not refresh. Pull to try again.").type(.xs).foregroundStyle(Tokens.textMuted)
      }
      if model.truncated {
        Text("More items match. Search to find the rest.").type(.xs).foregroundStyle(Tokens.textMuted)
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
      }
    }
  }
}

private struct InboxRow: View {
  @Environment(AppModel.self) private var app
  @Environment(WindowModel.self) private var window
  let item: InboxItem

  var body: some View {
    Button {
      window.path = [.inboxItem(item.id)]
    } label: {
      HStack(alignment: .top, spacing: 8) {
        Dot(color: item.kind == "notice" ? Tokens.textFaint : Tokens.accent, size: 8)
          .frame(width: 14)
          .padding(.top, 6)
        VStack(alignment: .leading, spacing: 4) {
          Text(item.title)
            .type(.sm, .medium)
            .foregroundStyle(Tokens.text)
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
      .background(selected ? Tokens.fillHover : .clear)
      .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle())
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("inbox-row")
  }

  /// Open beside the list.
  private var selected: Bool { window.path.first == .inboxItem(item.id) }

  private var subtitle: String {
    // The dashboard names an action without a question by its source, such
    // as "To do for you". MCP does not send the source, so the row names none.
    var parts: [String] = item.kind == "notice" ? ["Notice"] : item.question == nil ? [] : ["Question"]
    if let subject = item.subject?.title { parts.append(subject) }
    if let date = item.createdAt.date { parts.append(app.clock.relative(date)) }
    return parts.joined(separator: " · ")
  }
}
