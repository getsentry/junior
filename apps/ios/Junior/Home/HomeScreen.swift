import JuniorKit
import SwiftUI

/// Route `/`: search, grouped Conversation cards, and the new-conversation
/// composer docked at the bottom (`ConversationWorkspace` stacked home).
struct HomeScreen: View {
  @Environment(AppModel.self) private var app
  @State private var model = HomeModel()
  @State private var archiveError: String?
  @State private var undo: ConversationSummary?
  @FocusState private var searchFocused: Bool

  var body: some View {
    VStack(spacing: 0) {
      AppHeader(title: app.agentName)
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12, pinnedViews: [.sectionHeaders]) {
          SearchField(placeholder: "Search conversations…", text: $model.query)
            .focused($searchFocused)
          content
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 12)
      }
      .scrollDismissesKeyboard(.interactively)
      .refreshable { await model.load(app.client) }
      .overlay(alignment: .bottom) { toast }
      NewConversationComposer()
    }
    .background(Tokens.bg)
    .toolbar(.hidden, for: .navigationBar)
    .task(id: app.conversationsVersion) { await model.load(app.client) }
    .task(id: model.query) {
      // Debounce like the dashboard (250ms) before a server search.
      try? await Task.sleep(for: .milliseconds(250))
      if !Task.isCancelled { await model.load(app.client) }
    }
    .onChange(of: app.focusSearch, initial: true) { _, focus in
      if focus {
        searchFocused = true
        app.focusSearch = false
      }
    }
  }

  @ViewBuilder private var content: some View {
    if model.loading {
      HomeSkeleton()
    } else if let error = model.error, model.rows.isEmpty {
      EmptyBox(text: error.localizedDescription) { Task { await model.load(app.client) } }
    } else {
      let sections = model.sections(clock: app.clock)
      if sections.isEmpty {
        EmptyBox(text: "No conversations match this view.")
      }
      ForEach(sections) { section in
        let collapsed = Binding(
          get: { model.collapsed.contains(section.id) },
          set: { value in
            if value { model.collapsed.insert(section.id) } else { model.collapsed.remove(section.id) }
          })
        Section {
          if !collapsed.wrappedValue {
            VStack(spacing: 8) {
              ForEach(section.rows) { row in
                ConversationCard(
                  row: row,
                  needsYou: model.waiting.keys.contains(row.conversationId) && row.status != .active,
                  onArchive: { archive(row) })
              }
            }
            .padding(.bottom, 8)
          }
        } header: {
          SectionHeading(title: section.title, count: section.rows.count, collapsed: collapsed)
            .background(Tokens.bg)
        }
      }
      if model.nextCursor != nil {
        LoadMoreRow(failed: model.loadMoreFailed) { Task { await model.loadMore(app.client) } }
          .task { await model.loadMore(app.client) }
      }
    }
  }

  @ViewBuilder private var toast: some View {
    if let undo {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Conversation archived").font(.dashboard(.sm, .medium)).foregroundStyle(Tokens.text)
          Text(undo.title).font(.dashboard(.xs)).foregroundStyle(Tokens.textMuted).lineLimit(1)
        }
        Spacer()
        Button("Undo") {
          let row = undo
          self.undo = nil
          Task { try? await model.setArchived(row, archived: false, client: app.client) }
        }
        .buttonStyle(.dashboard(.outline))
      }
      .padding(12)
      .background(Tokens.surfaceRaised, in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.borderEmphasis))
      .padding(12)
      .transition(.move(edge: .bottom).combined(with: .opacity))
      .task(id: undo.conversationId) {
        try? await Task.sleep(for: .seconds(6))
        withAnimation { self.undo = nil }
      }
    } else if let archiveError {
      InlineError(text: archiveError)
        .padding(12)
        .background(Tokens.surfaceRaised, in: RoundedRectangle(cornerRadius: 10))
        .padding(12)
        .task {
          try? await Task.sleep(for: .seconds(4))
          self.archiveError = nil
        }
    }
  }

  private func archive(_ row: ConversationSummary) {
    Task {
      do {
        withAnimation { undo = row }
        try await model.setArchived(row, archived: true, client: app.client)
      } catch {
        withAnimation {
          undo = nil
          archiveError = (error as? JuniorAPIError)?.localizedDescription ?? "Could not archive."
        }
      }
    }
  }
}

/// One home card (`ConversationHomeList.tsx`).
struct ConversationCard: View {
  @Environment(AppModel.self) private var app
  let row: ConversationSummary
  let needsYou: Bool
  let onArchive: () -> Void

  var body: some View {
    Button {
      app.path.append(.conversation(row.conversationId))
    } label: {
      HStack(alignment: .top, spacing: 12) {
        tile
        VStack(alignment: .leading, spacing: 0) {
          HStack(spacing: 12) {
            Text(row.title)
              .font(.dashboard(.sm, .medium, family: .display))
              .foregroundStyle(Tokens.text)
              .lineLimit(1)
              .frame(height: 24)
              .frame(maxWidth: .infinity, alignment: .leading)
            trailing
          }
          preview
          tags
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .listCard()
      .contentShape(RoundedRectangle(cornerRadius: 8))
    }
    .buttonStyle(PressableStyle(pressedFill: Tokens.fillSoft, scale: 0.99))
    .contextMenu {
      Button("Archive", systemImage: "archivebox", action: onArchive)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityText)
    .accessibilityAddTraits(.isButton)
    .accessibilityAction { app.path.append(.conversation(row.conversationId)) }
    .accessibilityAction(named: row.archivedAt == nil ? "Archive" : "Restore", onArchive)
  }

  /// A short spoken summary: title, state, time, and the preview's first line.
  private var accessibilityText: String {
    var parts = [row.title]
    if needsYou { parts.append("Needs you") }
    if row.isPrivate { parts.append("Private") }
    switch row.status {
    case .active: parts.append("Working")
    case .failed: parts.append("Failed")
    case .stopped: parts.append("Stopped")
    default: if let date = row.activityAt { parts.append(app.clock.activityDay(date)) }
    }
    if let preview = row.activityPreview {
      let line = plainText(fromMarkdown: preview.text).split(separator: "\n").first.map(String.init) ?? ""
      parts.append(line.count > 140 ? String(line.prefix(139)) + "…" : line)
    }
    return parts.joined(separator: ", ")
  }

  private var tile: some View {
    Icon(row.isPrivate ? "lock-keyhole" : "message-square", size: 15)
      .foregroundStyle(Tokens.textMuted)
      .frame(width: 32, height: 32)
      .background(Tokens.surfacePanel, in: RoundedRectangle(cornerRadius: 6))
      .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.borderSubtle))
      .overlay(alignment: .bottomTrailing) {
        if needsYou {
          Circle().fill(Tokens.surfacePanel).frame(width: 14, height: 14)
            .overlay(Dot(color: Tokens.accent))
            .offset(x: -1, y: -1)
            .accessibilityLabel("Needs you")
        }
      }
      .padding(.top, 2)
  }

  @ViewBuilder private var trailing: some View {
    if row.status == .active {
      Spinner()
        .foregroundStyle(Tokens.textMuted)
        .frame(minWidth: 56, alignment: .trailing)
        .accessibilityElement()
        .accessibilityLabel("Working")
    } else {
      HStack(spacing: 12) {
        if row.status == .failed {
          Text("Failed").font(.dashboard(.xs)).foregroundStyle(Color.palette(.rose, 400))
        } else if row.status == .stopped {
          Text("Stopped").font(.dashboard(.xs)).foregroundStyle(Tokens.textMuted)
        }
        if let date = row.activityAt {
          Text(app.clock.activityDay(date))
            .font(.dashboard(.xs))
            .monospacedDigit()
            .foregroundStyle(Tokens.textMuted)
            .frame(minWidth: 56, alignment: .trailing)
        }
      }
    }
    Button(action: onArchive) {
      Icon(row.archivedAt == nil ? "archive" : "archive-restore", size: 15)
        .foregroundStyle(Tokens.textMuted)
        .padding(8)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .padding(-8)
    .accessibilityLabel(row.archivedAt == nil ? "Archive" : "Restore")
  }

  @ViewBuilder private var preview: some View {
    if let preview = row.activityPreview {
      Text(styledInline(plainBlocks(preview.text), step: .sm, color: Tokens.textSubtle, singleLine: true))
        .lineLimit(1)
        .frame(height: 20)
    } else if row.status == .active {
      Text("Working…").font(.dashboard(.sm)).foregroundStyle(Tokens.textMuted).frame(height: 20)
    }
  }

  @ViewBuilder private var tags: some View {
    let slack = slackLocationLabel(
      channel: row.channel, name: row.channelName, redacted: row.channelNameRedacted)
    let links = (row.annotations ?? []).filter { $0.url != nil }
    if (slack != nil && slack != row.title) || !links.isEmpty {
      HStack(spacing: 6) {
        if let slack, slack != row.title {
          TagChip(label: slack, outbound: row.locationUrl != nil) {
            PathIcon.slack(size: 12).foregroundStyle(Tokens.textMuted)
          }
          .layoutPriority(1)
        }
        if let link = links.first {
          LinkedWorkChip(annotation: link, shortLabel: shortLabel(for: link))
        }
        if links.count > 1 {
          Text("+\(links.count - 1)").font(.dashboard(.xxs)).monospacedDigit().foregroundStyle(Tokens.textMuted)
            .layoutPriority(1)
        }
      }
      .padding(.top, 4)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func shortLabel(for annotation: Annotation) -> String {
    row.sidebarAnnotations?.first { $0.key == annotation.key }?.label ?? annotation.label
  }

  /// Flatten Markdown blocks into one inline line, like the preview does.
  private func plainBlocks(_ text: String) -> String {
    parseMarkdown(text).map { block -> String in
      switch block {
      case .paragraph(let text), .heading(_, let text): text
      case .code(_, let code): code
      case .quote(let inner): inner.map { if case .paragraph(let t) = $0 { t } else { "" } }.joined(separator: " ")
      case .list(_, _, let items):
        items.flatMap(\.blocks).map { if case .paragraph(let t) = $0 { t } else { "" } }.joined(separator: " ")
      case .table(let table): (table.header + table.rows.flatMap { $0 }).joined(separator: " ")
      case .rule: ""
      }
    }.joined(separator: " ")
  }
}

/// A linked-work tag: Octicon in its status color, label, and title.
struct LinkedWorkChip: View {
  let annotation: Annotation
  let shortLabel: String

  var body: some View {
    let presentation = ObjectPresentation(objectType: annotation.objectType, status: annotation.status)
    let detail = annotation.title != annotation.label ? annotation.title : annotation.description
    TagChip(label: detail == nil ? annotation.label : shortLabel, detail: detail, maxWidth: 384, outbound: true) {
      PathIcon.octicon(presentation.icon, size: 12).foregroundStyle(presentation.color)
    }
  }
}

private struct LoadMoreRow: View {
  let failed: Bool
  let retry: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      if failed {
        Text("Could not load more.").font(.dashboard(.sm)).foregroundStyle(Tokens.textMuted)
        Button("Retry", action: retry).buttonStyle(.dashboard(.ghost))
      } else {
        ProgressView().controlSize(.small).tint(Tokens.textFaint)
      }
    }
    .frame(maxWidth: .infinity, minHeight: 40)
    .padding(.vertical, 8)
  }
}

private struct HomeSkeleton: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      group(3)
      group(2)
    }
    .accessibilityElement()
    .accessibilityLabel("Loading conversations")
  }

  private func group(_ count: Int) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Skeleton(width: 90, height: 12).padding(.vertical, 6).padding(.leading, 26)
      ForEach(0..<count, id: \.self) { _ in
        HStack(alignment: .top, spacing: 12) {
          Skeleton(width: 32, height: 32, radius: 6)
          VStack(alignment: .leading, spacing: 8) {
            Skeleton(width: 180, height: 14)
            Skeleton(height: 12)
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .listCard()
      }
    }
  }
}
