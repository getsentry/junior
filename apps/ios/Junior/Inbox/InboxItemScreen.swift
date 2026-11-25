import JuniorKit
import SwiftUI

/// Route `/inbox?item=…` on a phone (`InboxItemView.tsx`): the item, its
/// question, and the Conversations it came from. The public API reads Review
/// items; answering one happens on the web.
struct InboxItemScreen: View {
  @Environment(AppModel.self) private var app
  @Environment(WindowModel.self) private var window
  @Environment(InboxModel.self) private var inbox
  @Environment(\.dismiss) private var dismiss
  @Environment(\.splitColumn) private var column
  let itemId: String
  @State private var item: InboxItem?
  @State private var titles: [String: String] = [:]
  @State private var error: JuniorAPIError?

  var body: some View {
    VStack(spacing: 0) {
      AppHeader(title: app.agentName)
      if let item {
        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
            itemHeader(item)
            if !item.body.isEmpty {
              MarkdownView(blocks: parseMarkdown(item.body), step: .sm, color: Tokens.text)
            }
            card(item)
            if !item.conversationIds.isEmpty { conversations(item) }
            if let next = inbox.next(after: item.id) {
              Button {
                window.path.removeLast()
                window.path.append(.inboxItem(next.id))
              } label: {
                HStack(spacing: 6) {
                  Text("Next: \(next.title)").lineLimit(1)
                  Icon("arrow-right", size: 14)
                }
                .type(.sm, .medium)
                .foregroundStyle(Tokens.text)
              }
              .buttonStyle(.plain)
              .frame(maxWidth: .infinity, alignment: .trailing)
            }
          }
          .padding(.horizontal, 16)
          .padding(.top, 16)
          .padding(.bottom, 24)
          .readableWidth()
        }
        .refreshable { await load() }
      } else if let error {
        EmptyBox(text: error.localizedDescription) { Task { await load() } }.padding(16)
        Spacer()
      } else {
        VStack(alignment: .leading, spacing: 8) {
          Skeleton(width: 60, height: 12)
          Skeleton(width: 260, height: 22)
          Skeleton(width: 200, height: 12)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        Spacer()
      }
    }
    .background(Tokens.bg)
    .toolbar(.hidden, for: .navigationBar)
    .task(id: itemId) { await load() }
  }

  private func load() async {
    do {
      let loaded = try await app.call("getInboxItem", ["id": .string(itemId)], as: InboxItemResult.self).item
      item = loaded
      error = nil
      await loadTitles(loaded.conversationIds)
    } catch let failure as JuniorAPIError {
      if item == nil { error = failure }
    } catch {}
  }

  /// Titles of the linked Conversations that the viewer takes part in.
  private func loadTitles(_ ids: [String]) async {
    for id in ids.prefix(5) where titles[id] == nil {
      if let state = try? await app.call("getConversation", ["conversationId": .string(id)], as: ConversationState.self)
      {
        titles[id] = state.conversation.title
      }
    }
  }

  private func itemHeader(_ item: InboxItem) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      // Beside the list, there is nothing to go back to.
      if column != .detailRoot {
        Button {
          dismiss()
        } label: {
          HStack(spacing: 4) {
            Icon("chevron-left", size: 14)
            Text("Inbox")
          }
          .type(.xs)
          .foregroundStyle(Tokens.textMuted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Back to Inbox")
      }
      Text(item.title)
        .type(.xl, .medium, family: .display)
        .tracking(-0.5)
        .foregroundStyle(Tokens.text)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
      HStack(spacing: 8) {
        HStack(spacing: 6) {
          Dot(color: item.status == "open" ? Tokens.accent : Tokens.textMuted)
          Text(statusLabel(item))
            .type(.xs, .medium)
        }
        .foregroundStyle(item.status == "open" ? Tokens.accent : Tokens.textMuted)
        if let date = item.createdAt.date {
          Text(app.clock.relative(date)).type(.xs).foregroundStyle(Tokens.textMuted)
        }
      }
    }
  }

  /// The question and where to answer it.
  private func card(_ item: InboxItem) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      if let question = item.question {
        Text(question).type(.base, .medium).foregroundStyle(Tokens.text).fixedSize(horizontal: false, vertical: true)
      }
      if let subject = item.subject {
        let label = subject.title ?? subject.id
        if let url = subject.url {
          Button {
            window.openLink(url)
          } label: {
            TagChip(label: label, maxWidth: 300, outbound: true) {
              Icon("link", size: 12).foregroundStyle(Tokens.textMuted)
            }
          }
          .buttonStyle(.plain)
        } else {
          TagChip(label: label, maxWidth: 300) { Icon("link", size: 12).foregroundStyle(Tokens.textMuted) }
        }
      }
      Text(assignees(item)).type(.xs).foregroundStyle(Tokens.textMuted)
      if let url = item.url {
        Button(webActionLabel(item)) {
          window.openLink(url)
        }
        .buttonStyle(.dashboard(item.canAct ? .primary : .outline))
        .accessibilityIdentifier("answer-on-web")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(16)
    .panelCard(radius: 10)
  }

  /// Like the dashboard's `inboxItemStatusLabel`. An action without a
  /// question, such as a To-do or an Automation alert, has nothing to answer.
  private func statusLabel(_ item: InboxItem) -> String {
    guard item.status == "open" else { return item.status.capitalized }
    if item.kind == "notice" { return "Notice" }
    return item.question == nil ? "Waiting on you" : "Needs an answer"
  }

  private func webActionLabel(_ item: InboxItem) -> String {
    guard item.canAct else { return "Open on the web" }
    if item.kind == "notice" { return "Dismiss on the web" }
    return item.question == nil ? "Open on the web" : "Answer on the web"
  }

  private func assignees(_ item: InboxItem) -> String {
    if item.assignees.isEmpty { return "Anyone can answer." }
    return "For " + ListFormatter.localizedString(byJoining: item.assignees) + "."
  }

  private func conversations(_ item: InboxItem) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("From").type(.xs, .semibold).foregroundStyle(Tokens.text).accessibilityAddTraits(.isHeader)
      ForEach(item.conversationIds, id: \.self) { id in
        Button {
          window.path.append(.conversation(id))
        } label: {
          HStack(spacing: 8) {
            Icon("message-square", size: 14).foregroundStyle(Tokens.textMuted)
            Text(titles[id] ?? "Conversation").type(.sm, .medium).foregroundStyle(Tokens.text).lineLimit(1)
            Spacer(minLength: 0)
            Icon("chevron-right", size: 14).foregroundStyle(Tokens.textMuted)
          }
          .padding(12)
          .listCard()
          .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(pressedFill: Tokens.fillSoft))
      }
    }
  }
}
