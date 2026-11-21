import JuniorKit
import SwiftUI

/// Route `/conversations/:id`: header with its location and the menu, the
/// transcript pinned to the latest message, queued messages, and the composer.
struct ConversationScreen: View {
  @Environment(AppModel.self) private var app
  @Environment(WindowModel.self) private var window
  @State private var model: ConversationModel
  @State private var showDetails = false
  @State private var shareURL: URL?
  @State private var atBottom = true
  @State private var width: CGFloat = 0

  init(conversationId: String) {
    _model = State(initialValue: ConversationModel(conversationId: conversationId))
  }

  var body: some View {
    VStack(spacing: 0) {
      header
      transcript
      ConversationComposer(model: model)
    }
    .background(Tokens.bg)
    .toolbar(.hidden, for: .navigationBar)
    .inspector(isPresented: Binding(get: { showDetails && detailsBeside }, set: { showDetails = $0 })) {
      details
        .background(Tokens.bgElevated)
        .inspectorColumnWidth(min: 300, ideal: 340, max: 400)
    }
    // Measured around the panel, so opening it does not change where it shows.
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    .task { await model.open(app) }
    .task(id: app.isActive) {
      // Follow every 2s while a Turn runs or messages wait, and every 15s
      // otherwise, only while the app is in front.
      while app.isActive, !Task.isCancelled {
        try? await Task.sleep(for: .seconds(model.isLive ? 2 : 15))
        guard !Task.isCancelled, model.state != nil else { continue }
        await model.refresh(app)
      }
    }
    .onChange(of: model.state != nil) { _, loaded in
      if loaded, window.openDetails {
        window.openDetails = false
        showDetails = true
      }
    }
    .sheet(isPresented: Binding(get: { showDetails && !detailsBeside }, set: { showDetails = $0 })) {
      details
        .presentationDetents([.fraction(0.85), .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Tokens.bgElevated)
    }
    .sheet(item: $shareURL) { url in
      ShareSheet(items: [url]).presentationDetents([.medium])
    }
  }

  /// Room for the details panel beside a transcript at least 400pt wide;
  /// narrower screens get the sheet.
  private var detailsBeside: Bool { width >= 720 }

  @ViewBuilder private var details: some View {
    if let state = model.state {
      ConversationDetailsSheet(state: state) { showDetails = false }
    }
  }

  private var header: some View {
    AppHeader(
      title: model.conversation?.title ?? "Conversation", leading: .back, displayTitle: true,
      titleAlignment: .leading
    ) {
      menu
    } below: {
      LocationTag(conversation: model.conversation)
    }
  }

  private var menu: some View {
    Menu {
      Button("Conversation details", systemImage: "info.circle") { showDetails = true }
      if let url = model.conversation?.url.flatMap(URL.init(string:)) {
        Button("Share", systemImage: "square.and.arrow.up") { shareURL = url }
        Button("Open on the web", systemImage: "safari") { window.openLink(url.absoluteString) }
      }
      Button("Copy as Markdown", systemImage: "doc.on.doc") {
        UIPasteboard.general.string = model.markdown(agentName: app.agentName)
      }
      if let url = model.conversation?.locationUrl.flatMap(URL.init(string:)) {
        Link(destination: url) { Label("Open in Slack", systemImage: "arrow.up.right.square") }
      }
      Divider()
      if let conversation = model.conversation {
        let pinned = conversation.pinnedAt != nil
        if conversation.archivedAt == nil {
          Button(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin") {
            Task { await model.write("pinConversation", ["pinned": .bool(!pinned)], as: PinResult.self, app: app) }
          }
        }
        Button("Unfollow", systemImage: "bell.slash") {
          Task {
            if await model.write(
              "setConversationSubscription", ["subscribed": false], as: SubscriptionResult.self, app: app)
            {
              window.path.removeLast()
            }
          }
        }
        let archived = conversation.archivedAt != nil
        Button(archived ? "Restore" : "Archive", systemImage: archived ? "arrow.uturn.backward" : "archivebox") {
          Task {
            // `lastSeenAt` is the exact value the viewer saw; newer activity wins.
            await model.write(
              "archiveConversation",
              [
                "archived": .bool(!archived), "lastSeenAt": .string(conversation.lastSeenAt.raw),
                "applyToChildren": true,
              ], as: ArchiveResult.self, app: app)
          }
        }
      }
      Button("App menu", systemImage: "line.3.horizontal") {
        withAnimation(.snappy(duration: 0.25)) { window.drawerOpen = true }
      }
    } label: {
      Icon("ellipsis", size: 18)
        .foregroundStyle(Tokens.text)
        .frame(width: 36, height: 36)
        .contentShape(Rectangle())
    }
    .accessibilityLabel("Conversation menu")
  }

  @ViewBuilder private var transcript: some View {
    if let error = model.error, model.state == nil {
      ScrollView {
        EmptyBox(text: error.localizedDescription) { Task { await model.open(app) } }
          .padding(16)
      }
      .frame(maxHeight: .infinity)
    } else if model.state == nil {
      TranscriptSkeleton().frame(maxHeight: .infinity, alignment: .top)
    } else {
      ScrollViewReader { proxy in
        ScrollView {
          // A plain stack: a lazy one estimates row heights and opens past
          // the end of a transcript with tall rows.
          VStack(alignment: .leading, spacing: 4) {
            if model.olderCursor != nil {
              EarlierButton(loading: model.loadingEarlier) { Task { await model.loadEarlier(app) } }
            }
            if model.messages.isEmpty, model.conversation?.turnActive != true {
              Text("No messages yet.").type(.sm).foregroundStyle(Tokens.textMuted).padding(.leading, 32)
            }
            ForEach(model.messages) { message in
              MessageRow(message: message, blocks: model.messageBlocks[message.seq])
                .id(message.seq)
            }
            if model.conversation?.turnActive == true {
              WorkingRow()
            }
            if let actionError = model.actionError {
              InlineError(text: actionError).padding(.leading, 32)
            }
            if model.refreshFailed {
              Text("Could not refresh. Retrying…").type(.xs).foregroundStyle(Tokens.textMuted).padding(.leading, 32)
            }
            // The web's scroller `pb-4` plus the row's own padding.
            Color.clear.frame(height: 28).id("bottom")
              .onScrollVisibilityChange { atBottom = $0 }
          }
          .padding(.horizontal, 16)
          .padding(.top, 12)
          .readableWidth()
        }
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .scrollDismissesKeyboard(.interactively)
        .onAppear { scrollToBottom(proxy, animated: false) }
        .onChange(of: model.messages.last?.seq) { old, _ in
          // Follow new messages only for a reader at the end, not one reading back.
          if old == nil || atBottom { scrollToBottom(proxy, animated: old != nil) }
        }
      }
    }
  }

  private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
    Task { @MainActor in
      // Let the rows lay out first.
      try? await Task.sleep(for: .milliseconds(50))
      if animated {
        withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
      } else {
        proxy.scrollTo("bottom", anchor: .bottom)
      }
    }
  }
}

private struct PinResult: Decodable, Sendable { var pinnedAt: Timestamp? }
private struct ArchiveResult: Decodable, Sendable { var archivedAt: Timestamp? }
private struct SubscriptionResult: Decodable, Sendable { var subscribed: Bool }

/// The Slack Location under the title, linked to the thread.
private struct LocationTag: View {
  let conversation: MCPConversation?

  var body: some View {
    if let conversation, let label = conversation.locationLabel {
      HStack(spacing: 6) {
        if let url = conversation.locationUrl.flatMap(URL.init(string:)) {
          Link(destination: url) { chip(label, conversation, outbound: true) }
        } else {
          chip(label, conversation, outbound: false)
        }
        Spacer(minLength: 0)
      }
      .padding(.leading, 60)
      .padding(.trailing, 12)
      // The web pulls the tags up under the title (`-mt-1.5 pb-0.5` in a
      // single `py-2` header).
      .padding(.top, -14)
      .padding(.bottom, 10)
    }
  }

  private func chip(_ label: String, _ conversation: MCPConversation, outbound: Bool) -> some View {
    TagChip(label: label, outbound: outbound) {
      if conversation.surface == "slack" {
        PathIcon.slack(size: 12).foregroundStyle(Tokens.textMuted)
      } else {
        Icon("clock", size: 12).foregroundStyle(Tokens.textMuted)
      }
    }
  }
}

private struct EarlierButton: View {
  let loading: Bool
  let action: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Rectangle().fill(Tokens.border).frame(height: 1)
      Button(loading ? "Loading earlier messages…" : "Show earlier messages", action: action)
        .type(.xs, .medium)
        .foregroundStyle(Tokens.textMuted)
        .disabled(loading)
        .fixedSize()
      Rectangle().fill(Tokens.border).frame(height: 1)
    }
    .padding(.vertical, 8)
  }
}

/// Messages that wait for a Turn (`PendingMailboxStack.tsx`), with Cancel.
/// More than five collapse behind one row.
private struct QueuedStack: View {
  let messages: [PendingMessage]
  let onCancel: () -> Void
  @State private var expanded = false

  var body: some View {
    if !messages.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 6) {
          if messages.count > 5 {
            Button {
              withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
            } label: {
              HStack(spacing: 6) {
                Icon("chevron-right", size: 14).rotationEffect(.degrees(expanded ? 90 : 0))
                Text(expanded ? "Show fewer queued messages" : "\(messages.count) queued messages")
              }
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
          } else {
            Text(messages.count == 1 ? "1 queued message" : "\(messages.count) queued messages")
          }
          Spacer()
          Button("Cancel", action: onCancel)
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel queued messages")
        }
        .type(.xs, .medium)
        .foregroundStyle(Color.palette(.amber, 100).opacity(0.8))
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        if messages.count <= 5 || expanded {
          ForEach(messages) { message in
            HStack(spacing: 8) {
              Avatar(kind: .person(message.author))
              Text(message.text)
                .type(.sm)
                .foregroundStyle(Tokens.textSubtle)
                .lineLimit(1)
              Spacer(minLength: 0)
              Icon(message.delivery == "interrupt" ? "zap" : "clock-3", size: 13).foregroundStyle(Tokens.textMuted)
                .accessibilityLabel(message.delivery == "interrupt" ? "Joins the running turn" : "Queued")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
          }
        }
      }
      .background(
        Color.palette(.amber, 300).opacity(0.055),
        in: UnevenRoundedRectangle(topLeadingRadius: 8, topTrailingRadius: 8)
      )
      .padding(.horizontal, 16)
    }
  }
}

/// The Conversation composer: field, Stop while a Turn runs, Send. While a
/// Turn runs, Send queues the message; "Send now" joins the running Turn.
private struct ConversationComposer: View {
  @Environment(AppModel.self) private var app
  let model: ConversationModel
  @State private var text = ""
  @FocusState private var focused: Bool

  private var canSend: Bool {
    // Not before the page loads: the send's refresh needs the cursor.
    model.state != nil && !model.sending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var working: Bool { model.conversation?.turnActive == true }

  var body: some View {
    ComposerDock(hasAbove: !model.queued.isEmpty || model.state?.authorization != nil) {
      if let authorization = model.state?.authorization {
        AuthorizationPrompt(authorization: authorization)
      }
      QueuedStack(messages: model.queued) { Task { await model.cancelQueued(app) } }
    } content: {
      ComposerSurface(focused: focused) {
        HStack(alignment: .bottom, spacing: 0) {
          ComposerField(text: $text, placeholder: "Message \(app.agentName)…", focused: $focused)
          HStack(spacing: 12) {
            if working {
              Button {
                Task { await model.stop(app) }
              } label: {
                Group {
                  if model.stopping {
                    ProgressView().controlSize(.mini)
                  } else {
                    RoundedRectangle(cornerRadius: 2).fill(Tokens.text).frame(width: 11, height: 11)
                  }
                }
                .frame(width: 36, height: 36)
                .background(Tokens.surfaceRaised, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.borderEmphasis))
                .hitArea()
              }
              .buttonStyle(.plain)
              .disabled(model.stopping)
              .accessibilityLabel(model.stopping ? "Stopping" : "Stop")
            }
            SendButton(enabled: canSend) { send(interrupt: false) }
              .contextMenu {
                if working, canSend {
                  Button("Send now", systemImage: "bolt") { send(interrupt: true) }
                }
              }
              .accessibilityAction(named: "Send now") { if working, canSend { send(interrupt: true) } }
          }
          .padding(8)
        }
      }
    }
  }

  private func send(interrupt: Bool) {
    let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
    // Block a second tap before the task starts.
    model.sending = true
    Task {
      if await model.send(message, interrupt: interrupt, app: app) { text = "" }
    }
  }
}

private struct TranscriptSkeleton: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 24) {
      ForEach(0..<3, id: \.self) { index in
        HStack(alignment: .top, spacing: 8) {
          Skeleton(width: 24, height: 24, radius: 12)
          VStack(alignment: .leading, spacing: 8) {
            Skeleton(width: 120, height: 14)
            Skeleton(height: 14)
            Skeleton(width: index == 1 ? 160 : 240, height: 14)
          }
        }
      }
    }
    .padding(16)
    .accessibilityElement()
    .accessibilityLabel("Loading conversation")
  }
}

/// System share sheet.
struct ShareSheet: UIViewControllerRepresentable {
  let items: [Any]

  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: items, applicationActivities: nil)
  }

  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// A parked Turn waits for the viewer to connect an account.
private struct AuthorizationPrompt: View {
  let authorization: PendingAuthorization

  var body: some View {
    HStack(spacing: 12) {
      Icon("lock-keyhole", size: 14).foregroundStyle(Tokens.accentText)
      Text("Connect to continue this conversation.")
        .type(.xs)
        .foregroundStyle(Tokens.text)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let url = URL(string: authorization.url) {
        Link(destination: url) {
          Text(authorization.label)
        }
        .buttonStyle(.dashboard(.outline))
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(Tokens.accent.opacity(0.08), in: UnevenRoundedRectangle(topLeadingRadius: 8, topTrailingRadius: 8))
    .padding(.horizontal, 16)
  }
}
