import JuniorKit
import SwiftUI

/// Route `/conversations/:id`: header with context tags and the menu, the
/// transcript pinned to the latest row, queued messages, and the composer.
struct ConversationScreen: View {
  @Environment(AppModel.self) private var app
  @State private var model: ConversationModel
  @State private var showDetails = false
  @State private var renaming = false
  @State private var newTitle = ""
  @State private var shareURL: URL?
  @State private var forkFrom: String?
  @State private var atBottom = true

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
    .task(id: app.conversationVersion) { await model.load(app.client, openAtUnread: !app.openAtLatest) }
    .task(id: model.isLive && app.isActive) {
      // Poll every 2s while the agent works or messages wait, and only while
      // the app is in front.
      while model.isLive, app.isActive, !Task.isCancelled {
        try? await Task.sleep(for: .seconds(2))
        guard !Task.isCancelled else { return }
        await model.load(app.client)
      }
    }
    .onAppear { app.openConversationId = model.conversationId }
    .onChange(of: model.detail != nil) { _, loaded in
      if loaded, app.openDetails {
        app.openDetails = false
        showDetails = true
      }
    }
    .onDisappear {
      if app.openConversationId == model.conversationId { app.openConversationId = nil }
    }
    .sheet(isPresented: $showDetails) {
      if let detail = model.detail {
        ConversationDetailsSheet(detail: detail)
          .presentationDetents([.fraction(0.85), .large])
          .presentationDragIndicator(.visible)
          .presentationBackground(Tokens.bgElevated)
      }
    }
    .alert("Rename conversation", isPresented: $renaming) {
      TextField("Title", text: $newTitle)
      Button("Cancel", role: .cancel) {}
      Button("Save") {
        struct Body: Encodable { var title: String }
        Task { await model.patch("title", Body(title: newTitle), client: app.client) }
      }
    }
    .sheet(item: Binding(get: { forkFrom.map(ForkTarget.init) }, set: { forkFrom = $0?.id })) { target in
      ForkSheet(conversationId: model.conversationId, messageId: target.id)
        .presentationDetents([.height(260)])
        .presentationBackground(Tokens.bgElevated)
    }
    .sheet(item: $shareURL) { url in
      ShareSheet(items: [url]).presentationDetents([.medium])
    }
  }

  private var header: some View {
    AppHeader(
      title: model.detail?.title ?? "Conversation", leading: .back, displayTitle: true,
      titleAlignment: .leading
    ) {
      menu
    } below: {
      ContextTags(detail: model.detail)
    }
  }

  private var menu: some View {
    Menu {
      Button("Conversation details", systemImage: "info.circle") { showDetails = true }
      Button("Share", systemImage: "square.and.arrow.up") {
        shareURL =
          URL(
            string: "/conversations/\(model.conversationId.pathEscaped)", relativeTo: app.server.baseURL)?
          .absoluteURL
      }
      Button("Copy as Markdown", systemImage: "doc.on.doc") {
        UIPasteboard.general.string = model.markdown
      }
      if let url = model.detail?.locationUrl.flatMap(URL.init(string:)) {
        Link(destination: url) { Label("Open in Slack", systemImage: "arrow.up.right.square") }
      }
      Button("Open event log", systemImage: "scroll") {
        app.openOnWeb("/conversations/\(model.conversationId.pathEscaped)/events")
      }
      if let sentry = model.detail?.sentryConversationUrl.flatMap(URL.init(string:)) {
        Link(destination: sentry) { Label("Open in Sentry", systemImage: "arrow.up.right.square") }
      }
      Divider()
      if let detail = model.detail {
        if detail.archivedAt == nil {
          let pinned = detail.pinnedAt != nil
          Button(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin") {
            struct Body: Encodable { var pinned: Bool }
            Task {
              await model.patch("pin", Body(pinned: !pinned), client: app.client)
              app.didWrite()
            }
          }
          .disabled(detail.isParticipant != true || detail.parentConversationId != nil)
        }
        if detail.isParticipant == true {
          Button("Rename", systemImage: "pencil") {
            newTitle = detail.title
            renaming = true
          }
        }
        // Participants only; the field is absent for anyone else.
        if let subscribed = detail.subscribed {
          Button(subscribed ? "Unsubscribe" : "Subscribe", systemImage: subscribed ? "bell.slash" : "bell") {
            struct Body: Encodable { var subscribed: Bool }
            Task { await model.patch("subscription", Body(subscribed: !subscribed), client: app.client) }
          }
        }
        if detail.isParticipant == true {
          let archived = detail.archivedAt != nil
          Button(archived ? "Restore" : "Archive", systemImage: archived ? "arrow.uturn.backward" : "archivebox") {
            struct Body: Encodable {
              var archived: Bool
              /// The exact `lastSeenAt` the viewer saw; newer activity wins.
              var lastSeenAt: String?
              var applyToChildren = true
            }
            Task {
              await model.patch(
                "archive", Body(archived: !archived, lastSeenAt: detail.lastSeenAt?.raw), client: app.client)
              app.didWrite()
            }
          }
        }
      }
      Button("App menu", systemImage: "line.3.horizontal") {
        withAnimation(.snappy(duration: 0.25)) { app.drawerOpen = true }
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
    if let error = model.error, model.detail == nil {
      ScrollView {
        EmptyBox(text: error.localizedDescription) { Task { await model.load(app.client) } }
          .padding(16)
      }
      .frame(maxHeight: .infinity)
    } else if model.detail == nil {
      TranscriptSkeleton().frame(maxHeight: .infinity, alignment: .top)
    } else {
      ScrollViewReader { proxy in
        ScrollView {
          // A plain stack: a lazy one estimates row heights and opens past
          // the end of a transcript with tall rows.
          VStack(alignment: .leading, spacing: 4) {
            if model.previousCursor != nil {
              EarlierButton(loading: model.loadingEarlier) { Task { await model.loadEarlier(app.client) } }
            }
            ForEach(model.transcript.rows) { row in
              if row.id == model.firstUnreadRowId {
                NewDivider().id("new")
              }
              rowView(row)
                .id(row.id)
                // Any part on screen counts, so a reply taller than the screen
                // is read too (the web reports rows that reach the viewport).
                .onScrollVisibilityChange(threshold: 0.01) { visible in
                  if visible, let seq = row.seq { model.noteSeen(seq, client: app.client) }
                }
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
        }
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .scrollDismissesKeyboard(.interactively)
        .onAppear { scrollToStart(proxy) }
        .onChange(of: model.transcript.rows.last?.id) { old, _ in
          if old == nil {
            scrollToStart(proxy)
          } else if atBottom {
            // Follow new rows only for a reader at the end, not one reading back.
            withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
          }
        }
      }
    }
  }

  /// Open at the first unread row ("Where I left off") or at the latest.
  private func scrollToStart(_ proxy: ScrollViewProxy) {
    guard !model.transcript.rows.isEmpty else { return }
    Task { @MainActor in
      // Let the rows lay out first.
      try? await Task.sleep(for: .milliseconds(50))
      if !app.openAtLatest, model.firstUnreadRowId != nil {
        proxy.scrollTo("new", anchor: .top)
      } else {
        proxy.scrollTo("bottom", anchor: .bottom)
      }
      // Count rows as read only once the page sits where it opens.
      try? await Task.sleep(for: .milliseconds(400))
      model.trackingReads = true
    }
  }

  @ViewBuilder private func rowView(_ row: TranscriptRow) -> some View {
    switch row {
    case .message(let message):
      MessageRow(
        message: message, slackSurface: model.detail?.surface == "slack", blocks: model.messageBlocks[message.id],
        onFork: model.detail?.canFork == true && message.forkable ? { forkFrom = message.id } : nil)
    case .activity(let activity): ActivityRow(activity: activity)
    case .failure(let failure): FailureRow(failure: failure)
    case .thread(let thread): ThreadCard(thread: thread)
    case .delivered(let delivery): DeliveredRow(delivery: delivery)
    case .thinking: ThinkingRow()
    }
  }
}

/// The tags under the title: Slack Location, repository, linked work.
private struct ContextTags: View {
  let detail: ConversationDetail?

  var body: some View {
    let slack = slackLocationLabel(
      channel: detail?.channel, name: detail?.channelName, redacted: detail?.channelNameRedacted)
    let links = (detail?.annotations ?? []).filter { $0.url != nil }
    let repo = repository(links)
    if slack != nil || !links.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          if let slack {
            link(detail?.locationUrl) {
              TagChip(label: slack, outbound: detail?.locationUrl != nil) {
                PathIcon.slack(size: 12).foregroundStyle(Tokens.textMuted)
              }
            }
          }
          if let repo {
            link("https://github.com/\(repo)") {
              TagChip(label: repo, maxWidth: 240, outbound: true) {
                PathIcon.github(size: 12).foregroundStyle(Tokens.textMuted)
              }
            }
          }
          ForEach(links, id: \.key) { annotation in
            let presentation = ObjectPresentation(objectType: annotation.objectType, status: annotation.status)
            link(annotation.url) {
              HStack(spacing: 8) {
                PathIcon.octicon(presentation.icon, size: 16).foregroundStyle(presentation.color)
                Text(annotation.label).type(.xs).foregroundStyle(Tokens.text)
              }
              .frame(minHeight: 24)
            }
          }
        }
        .padding(.leading, 60)
        .padding(.trailing, 12)
      }
      // The web pulls the tags up under the title (`-mt-1.5 pb-0.5` in a
      // single `py-2` header).
      .padding(.top, -14)
      .padding(.bottom, 10)
    }
  }

  /// `owner/repo` when every GitHub link is in one repository.
  private func repository(_ links: [Annotation]) -> String? {
    let repos = Set(
      links.compactMap { annotation -> String? in
        guard annotation.plugin == "github" else { return nil }
        return annotation.key.split(separator: "#").first.map(String.init)
      })
    return repos.count == 1 ? repos.first : nil
  }

  @ViewBuilder private func link<Content: View>(_ url: String?, @ViewBuilder _ content: () -> Content) -> some View {
    if let url = url.flatMap(URL.init(string:)) {
      Link(destination: url) { content() }
    } else {
      content()
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

/// Messages waiting for the next safe point (`PendingMailboxStack.tsx`).
/// More than five collapse behind one row.
private struct QueuedStack: View {
  let messages: [PendingMessage]
  @State private var expanded = false

  var body: some View {
    if !messages.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        if messages.count > 5 {
          Button {
            withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
          } label: {
            HStack(spacing: 6) {
              Icon("chevron-right", size: 14)
                .rotationEffect(.degrees(expanded ? 90 : 0))
              Text(expanded ? "Show fewer queued messages" : "\(messages.count) queued messages")
            }
            .type(.xs, .medium)
            .foregroundStyle(Color.palette(.amber, 100).opacity(0.8))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
        }
        if messages.count <= 5 || expanded {
          ForEach(messages) { message in
            HStack(spacing: 8) {
              Avatar(kind: .person(message.actorIdentity))
              Text(message.redacted == true ? "Hidden message" : (message.text ?? ""))
                .type(.sm)
                .italic(message.redacted == true)
                .foregroundStyle(Tokens.textSubtle)
                .lineLimit(1)
              Spacer(minLength: 0)
              if message.source == "slack" { PathIcon.slack(size: 12).foregroundStyle(Tokens.textMuted) }
              Icon(deliveryIcon(message), size: 13).foregroundStyle(Tokens.textMuted)
                .accessibilityLabel(message.delivery == "defer" ? "Queued" : "Steered")
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

  private func deliveryIcon(_ message: PendingMessage) -> String {
    switch message.delivery {
    case "defer": "clock-3"
    case "interrupt": message.source == "web" ? "zap" : "skip-forward"
    default: "clock-3"
    }
  }
}

/// The Conversation composer: field, attach, Stop while live, Send.
private struct ConversationComposer: View {
  @Environment(AppModel.self) private var app
  let model: ConversationModel
  @State private var text = ""
  @State private var files: [PendingUpload] = []
  @FocusState private var focused: Bool

  private var canSend: Bool {
    !model.sending && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty)
  }

  var body: some View {
    ComposerDock(hasAbove: !model.queued.isEmpty || model.detail?.mailbox?.authorization != nil) {
      if let authorization = model.detail?.mailbox?.authorization {
        AuthorizationPrompt(authorization: authorization)
      }
      QueuedStack(messages: model.queued)
    } content: {
      ComposerSurface(focused: focused) {
        VStack(alignment: .leading, spacing: 0) {
          UploadChips(files: $files)
          HStack(alignment: .bottom, spacing: 0) {
            ComposerField(text: $text, placeholder: "Message \(app.agentName)…", focused: $focused)
            HStack(spacing: 12) {
              AttachButton(files: $files)
              if model.detail?.status == .active {
                Button {
                  Task {
                    let restored = await model.stop(app.client)
                    if !restored.isEmpty { text = (restored + [text]).filter { !$0.isEmpty }.joined(separator: "\n\n") }
                  }
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
              SendButton(enabled: canSend) { send() }
            }
            .padding(8)
          }
        }
      }
    }
  }

  private func send() {
    let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let picked = files
    // Block a second tap before the task starts.
    model.sending = true
    Task {
      if await model.send(message, files: picked, client: app.client) {
        text = ""
        files = []
      }
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

struct ForkTarget: Identifiable {
  let id: String
}

/// "Fork Conversation" (`ForkConversationButton.tsx`): start a new
/// Conversation from one reply with a first message.
struct ForkSheet: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  let conversationId: String
  let messageId: String
  @State private var message = ""
  @State private var key = UUID().uuidString
  @State private var sending = false
  @State private var error: String?
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Fork Conversation").type(.lg, .semibold).foregroundStyle(Tokens.text)
      Text("Message").type(.sm, .medium).foregroundStyle(Tokens.text)
      ComposerField(text: $message, placeholder: "Message \(app.agentName)…", focused: $focused)
        .background(Tokens.control, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.borderEmphasis))
      if let error { InlineError(text: error) }
      HStack(spacing: 8) {
        Spacer()
        Button("Cancel") { dismiss() }.buttonStyle(.dashboard(.outline))
        Button(sending ? "Forking…" : "Fork") { fork() }
          .buttonStyle(.dashboard(.primary))
          .disabled(sending || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(16)
    .onAppear { focused = true }
  }

  private func fork() {
    struct Fork: Encodable {
      var messageId: String
      var idempotencyKey: String
    }
    struct Send: Encodable {
      var idempotencyKey: String
      var message: String
    }
    struct Created: Decodable { var conversationId: String }
    sending = true
    Task {
      defer { sending = false }
      do {
        let created: Created = try await app.client.send(
          "POST", "/api/conversations/\(conversationId.pathEscaped)/forks",
          body: Fork(messageId: messageId, idempotencyKey: key))
        try await app.client.perform(
          "POST", "/api/conversations/\(created.conversationId.pathEscaped)/messages",
          body: Send(idempotencyKey: key, message: message.trimmingCharacters(in: .whitespacesAndNewlines)))
        dismiss()
        app.didWrite()
        app.path.append(.conversation(created.conversationId))
      } catch {
        self.error = (error as? JuniorAPIError)?.localizedDescription ?? "Could not fork. Try again."
      }
    }
  }
}

/// The "New" line before the first row that was unread when the
/// Conversation opened (`TranscriptRows.tsx`).
private struct NewDivider: View {
  var body: some View {
    HStack(spacing: 12) {
      Rectangle().fill(Tokens.accent.opacity(0.5)).frame(height: 1)
      Text("New").type(.xs, .semibold).foregroundStyle(Tokens.accentText).fixedSize()
      Rectangle().fill(Tokens.accent.opacity(0.5)).frame(height: 1)
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
  }
}

/// A parked Turn waits for the viewer to connect an account.
private struct AuthorizationPrompt: View {
  let authorization: ConversationDetail.Authorization

  var body: some View {
    HStack(spacing: 12) {
      Icon("lock-keyhole", size: 14).foregroundStyle(Tokens.accentText)
      Text("Connect to continue this conversation.")
        .type(.xs)
        .foregroundStyle(Tokens.text)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let url = URL(string: authorization.authorizationUrl) {
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
