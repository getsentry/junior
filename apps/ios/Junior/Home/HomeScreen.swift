import JuniorKit
import SwiftUI

/// Route `/`: search, grouped Conversation cards, and the new-conversation
/// composer docked at the bottom (`ConversationWorkspace` stacked home).
struct HomeScreen: View {
  @Environment(AppModel.self) private var app
  @State private var model = HomeModel()
  @State private var archiveError: String?
  @State private var undo: MCPConversation?
  @State private var renaming: MCPConversation?
  @FocusState private var searchFocused: Bool
  @Environment(\.splitColumn) private var column

  var body: some View {
    VStack(spacing: 0) {
      AppHeader(title: app.agentName)
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
          if column == .list { NewConversationRow().padding(.bottom, 8) }
          SearchField(placeholder: "Search conversations…", text: $model.query)
            .focused($searchFocused)
            .padding(.bottom, 12)
          content
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 12)
      }
      .scrollDismissesKeyboard(.interactively)
      .refreshable { await model.load(app) }
      .overlay(alignment: .bottom) { toast }
      // Beside the list, the open pane has the composer.
      if column != .list { NewConversationComposer() }
    }
    .background(Tokens.bg)
    .toolbar(.hidden, for: .navigationBar)
    .renameAlert($renaming) { row, title in rename(row, title) }
    .task(id: app.conversationsVersion) { await model.load(app) }
    .task(id: model.query) {
      // Debounce like the dashboard (250ms) before a server search.
      try? await Task.sleep(for: .milliseconds(250))
      if !Task.isCancelled { await model.load(app) }
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
      EmptyBox(text: error.localizedDescription) { Task { await model.load(app) } }
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
                  row: row, onArchive: { archive(row) }, onPin: { pin(row) }, onRename: { renaming = row })
              }
            }
          }
        } header: {
          SectionHeading(title: section.title, count: section.rows.count, collapsed: collapsed)
            .padding(.bottom, collapsed.wrappedValue ? 0 : 2)
            .background(Tokens.bg)
        } footer: {
          // Sections sit 20pt apart (`gap-5`).
          Color.clear.frame(height: 20)
        }
      }
      if model.refreshFailed {
        Text("Could not refresh. Pull to try again.").type(.xs).foregroundStyle(Tokens.textMuted)
      }
    }
  }

  @ViewBuilder private var toast: some View {
    if let undo {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Conversation archived").type(.sm, .medium).foregroundStyle(Tokens.text)
          Text(undo.title).type(.xs).foregroundStyle(Tokens.textMuted).lineLimit(1)
        }
        Spacer()
        Button("Undo") {
          let row = undo
          self.undo = nil
          Task {
            do {
              try await model.setArchived(row, archived: false, app: app)
            } catch {
              archiveError = (error as? JuniorAPIError)?.localizedDescription ?? "Could not restore."
            }
          }
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

  /// Archive a row, or restore one that a search shows archived.
  private func archive(_ row: MCPConversation) {
    let archiving = row.archivedAt == nil
    Task {
      do {
        if archiving { withAnimation { undo = row } }
        try await model.setArchived(row, archived: archiving, app: app)
      } catch {
        withAnimation {
          undo = nil
          archiveError =
            (error as? JuniorAPIError)?.localizedDescription
            ?? (archiving ? "Could not archive." : "Could not restore.")
        }
      }
    }
  }
}

extension HomeScreen {
  private func pin(_ row: MCPConversation) {
    Task {
      do {
        try await model.setPinned(row, pinned: row.pinnedAt == nil, app: app)
      } catch {
        withAnimation { archiveError = (error as? JuniorAPIError)?.localizedDescription ?? "Could not pin." }
      }
    }
  }

  private func rename(_ row: MCPConversation, _ title: String) {
    Task {
      do {
        try await model.rename(row, title: title, app: app)
      } catch {
        withAnimation { archiveError = (error as? JuniorAPIError)?.localizedDescription ?? "Could not rename." }
      }
    }
  }
}

/// Above the list beside the open item: closes it to show the
/// new-conversation composer (`ConversationSidebar.tsx`).
private struct NewConversationRow: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    Button {
      app.path = []
    } label: {
      HStack(spacing: 8) {
        Icon("pencil", size: 12)
          .foregroundStyle(Tokens.accentText)
          .frame(width: 18, height: 18)
          .background(Tokens.accent.opacity(0.18), in: RoundedRectangle(cornerRadius: 6))
        Text("New conversation").type(.sm, .medium).foregroundStyle(Tokens.text)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(app.path.isEmpty ? Tokens.fillHover : .clear, in: RoundedRectangle(cornerRadius: 8))
      .contentShape(RoundedRectangle(cornerRadius: 8))
    }
    .buttonStyle(PressableStyle(pressedFill: Tokens.fillSoft))
    .accessibilityAddTraits(app.path.isEmpty ? .isSelected : [])
  }
}

/// One home card (`ConversationHomeList.tsx`): title, state, time, and where
/// the Conversation lives.
struct ConversationCard: View {
  @Environment(AppModel.self) private var app
  let row: MCPConversation
  let onArchive: () -> Void
  let onPin: () -> Void
  let onRename: () -> Void

  var body: some View {
    Button {
      app.path = [route]
    } label: {
      // A card with only a title centers it against the tile, as the web's
      // stretched column does.
      HStack(alignment: hasBody ? .top : .center, spacing: 12) {
        tile
        VStack(alignment: .leading, spacing: 0) {
          HStack(spacing: 12) {
            Text(row.title)
              .type(.sm, .medium, family: .display)
              .foregroundStyle(Tokens.text)
              .lineLimit(1)
              .frame(minHeight: 24)
              .frame(maxWidth: .infinity, alignment: .leading)
            trailing
          }
          if row.turnActive {
            Text("Working…").type(.sm).foregroundStyle(Tokens.textMuted).frame(minHeight: 20)
          }
          tags
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .listCard(selected: app.path.first == route)
      .contentShape(RoundedRectangle(cornerRadius: 8))
    }
    .buttonStyle(PressableStyle(pressedFill: Tokens.fillSoft, scale: 0.99))
    .contextMenu {
      Button(
        row.pinnedAt == nil ? "Pin" : "Unpin", systemImage: row.pinnedAt == nil ? "pin" : "pin.slash", action: onPin)
      Button("Rename", systemImage: "pencil", action: onRename)
      Button(row.archivedAt == nil ? "Archive" : "Restore", systemImage: "archivebox", action: onArchive)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityText)
    .accessibilityAddTraits(.isButton)
    .accessibilityAddTraits(app.path.first == route ? .isSelected : [])
    .accessibilityAction { app.path = [route] }
    .accessibilityAction(named: row.pinnedAt == nil ? "Pin" : "Unpin", onPin)
    .accessibilityAction(named: "Rename", onRename)
    .accessibilityAction(named: row.archivedAt == nil ? "Archive" : "Restore", onArchive)
  }

  /// A short spoken summary: title, state, and time.
  private var accessibilityText: String {
    var parts = [row.title]
    if row.pinnedAt != nil { parts.append("Pinned") }
    // A running Turn can also need input, so say both.
    if row.status == .needsInput { parts.append("Needs input") }
    if row.turnActive {
      parts.append("Working")
    } else if let date = row.lastSeenAt.date {
      parts.append(app.clock.activityDay(date))
    }
    if let location = row.locationLabel { parts.append(location) }
    return parts.joined(separator: ", ")
  }

  private var hasBody: Bool { row.turnActive || row.locationLabel != nil }

  private var route: Route { .conversation(row.conversationId) }

  private var tile: some View {
    Icon(row.surface == "scheduler" ? "clock" : "message-square", size: 15)
      .foregroundStyle(Tokens.textMuted)
      .frame(width: 32, height: 32)
      .background(Tokens.surfacePanel, in: RoundedRectangle(cornerRadius: 6))
      .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.borderSubtle))
      .padding(.top, hasBody ? 2 : 0)
  }

  @ViewBuilder private var trailing: some View {
    // A running Turn can also need input, so the spinner takes only the
    // date's place.
    HStack(spacing: 12) {
      if row.status == .needsInput {
        Text("Needs input").type(.xs).foregroundStyle(Color.palette(.amber, 400))
      }
      if row.turnActive {
        Spinner()
          .foregroundStyle(Tokens.textMuted)
          .frame(minWidth: 56, alignment: .trailing)
          .accessibilityElement()
          .accessibilityLabel("Working")
      } else if let date = row.lastSeenAt.date {
        Text(app.clock.activityDay(date))
          .type(.xs)
          .monospacedDigit()
          .foregroundStyle(Tokens.textMuted)
          .frame(minWidth: 56, alignment: .trailing)
      }
    }
    Button(action: onArchive) {
      Icon(row.archivedAt == nil ? "archive" : "archive-restore", size: 15)
        .foregroundStyle(Tokens.textMuted)
        .padding(8)
        .hitArea()
    }
    .buttonStyle(.plain)
    .padding(-8)
    .accessibilityLabel(row.archivedAt == nil ? "Archive" : "Restore")
  }

  @ViewBuilder private var tags: some View {
    if let location = row.locationLabel, location != row.title {
      HStack(spacing: 6) {
        TagChip(label: location, outbound: row.locationUrl != nil) {
          if row.surface == "slack" {
            PathIcon.slack(size: 12).foregroundStyle(Tokens.textMuted)
          } else {
            Icon("clock", size: 12).foregroundStyle(Tokens.textMuted)
          }
        }
      }
      .padding(.top, 4)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
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
