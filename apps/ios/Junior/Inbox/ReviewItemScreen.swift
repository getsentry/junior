import JuniorKit
import SwiftUI

/// Route `/review?item=…` on a phone (`ReviewItemView.tsx`): the item's
/// header, the Conversation around it, and the question card.
struct ReviewItemScreen: View {
  @Environment(AppModel.self) private var app
  @Environment(InboxModel.self) private var inbox
  @Environment(\.dismiss) private var dismiss
  let itemId: String
  @State private var item: ReviewItem?
  @State private var excerpt: [TranscriptMessage] = []
  @State private var dividerIndex: Int?
  @State private var error: JuniorAPIError?
  @State private var showDetails = false

  var body: some View {
    VStack(spacing: 0) {
      AppHeader(title: app.agentName)
      if let item {
        itemHeader(item)
        ScrollViewReader { proxy in
          ScrollView {
            VStack(alignment: .leading, spacing: 20) {
              ExcerptView(messages: excerpt, dividerIndex: dividerIndex)
              QuestionCard(item: item) { updated in
                self.item = updated
                app.didWrite()
              }
              .id("card")
              if let next = inbox.next(after: item.id) {
                Button {
                  app.path.removeLast()
                  app.path.append(.reviewItem(next.id))
                } label: {
                  HStack(spacing: 6) {
                    Text("Next: \(next.title)").lineLimit(1)
                    Icon("arrow-right", size: 14)
                  }
                  .font(.dashboard(.sm, .medium))
                  .foregroundStyle(Tokens.text)
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, alignment: .trailing)
              }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 24)
          }
          .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.top, for: .alignment)
          .onChange(of: excerpt.count) { proxy.scrollTo("card", anchor: .bottom) }
        }
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
    .sheet(isPresented: $showDetails) {
      if let item {
        ReviewItemDetails(item: item, source: inbox.source(of: item))
          .presentationDetents([.fraction(0.85)])
          .presentationCornerRadius(16)
          .presentationBackground(Tokens.bgElevated)
      }
    }
  }

  private func itemHeader(_ item: ReviewItem) -> some View {
    HStack(alignment: .top, spacing: 16) {
      VStack(alignment: .leading, spacing: 6) {
        Button {
          dismiss()
        } label: {
          HStack(spacing: 4) {
            Icon("chevron-left", size: 14)
            Text("Inbox")
          }
          .font(.dashboard(.xs))
          .foregroundStyle(Tokens.textMuted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Back to Inbox")
        Text(item.title)
          .font(.dashboard(.xl, .medium, family: .display))
          .tracking(-0.5)
          .foregroundStyle(Tokens.text)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
        let status = HStack(spacing: 6) {
          Dot(color: item.isOpen ? Tokens.accent : Tokens.textMuted)
          Text(item.statusLabel).font(.dashboard(.xs, .medium))
        }
        .foregroundStyle(item.isOpen ? Tokens.accent : Tokens.textMuted)
        .fixedSize()
        let meta = Text(meta(item)).font(.dashboard(.xs)).foregroundStyle(Tokens.textMuted)
        // The status and the source share a line when they fit, as flex-wrap does.
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 8) { status; meta.fixedSize() }
          VStack(alignment: .leading, spacing: 2) { status; meta.fixedSize(horizontal: false, vertical: true) }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Button {
        showDetails = true
      } label: {
        HStack(spacing: 8) {
          Icon("panel-right", size: 15)
          Text("Details")
        }
      }
      .buttonStyle(.dashboard(.outline))
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .background(Tokens.bg)
    .hairline(.bottom)
  }

  private func meta(_ item: ReviewItem) -> String {
    var parts = [inbox.source(of: item)]
    if let created = item.createdAt { parts.append(app.clock.relative(created)) }
    if item.visibility == .private { parts.append("Private") }
    return parts.joined(separator: " · ")
  }

  private func load() async {
    do {
      let item: ReviewItem = try await app.client.get("/api/review-items/\(itemId.pathEscaped)")
      self.item = item
      error = nil
      if inbox.sourceTitles.isEmpty { await inbox.load(app.client) }
      await loadExcerpt(item)
    } catch let error as JuniorAPIError {
      self.error = error
    } catch {}
  }

  /// The last three messages up to the item, then the first three after it.
  private func loadExcerpt(_ item: ReviewItem) async {
    guard let id = item.addedByConversationId else { return }
    guard let detail: ConversationDetail = try? await app.client.get("/api/conversations/\(id.pathEscaped)")
    else { return }
    let model = buildTranscript(events: detail.events, status: nil, fallbackAuthor: detail.actorIdentity)
    let messages = model.rows.compactMap { row -> TranscriptMessage? in
      if case .message(let message) = row, message.speaker != .system { return message }
      return nil
    }
    let created = item.createdAt ?? .distantFuture
    let before = messages.filter { ($0.createdAt ?? .distantPast) <= created }.suffix(3)
    let after = messages.filter {
      let date = $0.createdAt ?? .distantPast
      return date > created && date < (item.closedAt ?? .distantFuture)
    }.prefix(3)
    excerpt = Array(before) + Array(after)
    dividerIndex = after.isEmpty ? nil : before.count
  }
}

private struct ExcerptView: View {
  let messages: [TranscriptMessage]
  let dividerIndex: Int?

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
        if index == dividerIndex {
          HStack(spacing: 12) {
            Rectangle().fill(Tokens.accent.opacity(0.3)).frame(height: 1)
            Text("New since Junior asked")
              .font(.dashboard(.xs, .medium))
              .foregroundStyle(Tokens.accentText)
              .fixedSize()
            Rectangle().fill(Tokens.accent.opacity(0.3)).frame(height: 1)
          }
          .padding(.vertical, 4)
        }
        MessageRow(message: message, slackSurface: false)
      }
    }
  }
}

/// Item details sheet (`ReviewItemDetails.tsx`).
private struct ReviewItemDetails: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  let item: ReviewItem
  let source: String

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Review item details").font(.dashboard(.base, .semibold)).foregroundStyle(Tokens.text)
        Spacer()
        Button {
          dismiss()
        } label: {
          Icon("x", size: 16).foregroundStyle(Tokens.textMuted).frame(width: 36, height: 36)
        }
        .buttonStyle(PressableStyle(radius: 6))
        .accessibilityLabel("Close details")
      }
      .padding(.leading, 16)
      .padding(.trailing, 8)
      .padding(.vertical, 8)
      .hairline(.bottom, Tokens.borderSubtle)
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          if let body = item.body, !body.isEmpty {
            Text(body).font(.dashboard(.sm)).lineSpacing(8).foregroundStyle(Tokens.textMuted)
          }
          card("Assignees") {
            if assignees.isEmpty {
              Text("Unassigned")
                .font(.dashboard(.xs, .medium))
                .foregroundStyle(Color.palette(.amber, 300))
            } else {
              Text(assignees).font(.dashboard(.sm)).foregroundStyle(Tokens.text)
            }
          }
          card(nil) {
            VStack(spacing: 8) {
              row("Status", item.statusLabel)
              if let created = item.createdAt { row("Added", app.clock.relative(created)) }
              row("Added by", item.automationId == nil ? source : "\(source) · Automation")
              row("Visibility", item.visibility == .private ? "Private" : "Public")
            }
          }
          if let ids = item.conversationIds, !ids.isEmpty {
            card("Linked conversations", count: ids.count) {
              ForEach(ids, id: \.self) { id in
                Button {
                  dismiss()
                  app.path.append(.conversation(id))
                } label: {
                  Text(id == item.addedByConversationId ? source : id)
                    .font(.dashboard(.sm))
                    .underline()
                    .foregroundStyle(Tokens.text)
                }
                .buttonStyle(.plain)
              }
            }
          }
        }
        .padding(16)
      }
    }
    .background(Tokens.bgElevated)
  }

  private var assignees: String {
    var names = item.assignedToEveryone == true ? ["Everyone"] : []
    names += (item.assignees ?? []).compactMap { $0.displayName ?? $0.email }
    return names.joined(separator: ", ")
  }

  private func card<Content: View>(_ title: String?, count: Int? = nil, @ViewBuilder _ content: () -> Content)
    -> some View
  {
    VStack(alignment: .leading, spacing: 6) {
      if let title {
        HStack(spacing: 6) {
          Text(title).font(.dashboard(.xs, .medium)).foregroundStyle(Tokens.textMuted)
          if let count { Text("\(count)").font(.dashboard(.xs)).foregroundStyle(Tokens.textFaint) }
        }
      }
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .panelCard()
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(label).foregroundStyle(Tokens.textMuted).frame(width: 75, alignment: .leading)
      Text(value).foregroundStyle(Tokens.text)
      Spacer(minLength: 0)
    }
    .font(.dashboard(.xs))
  }
}
