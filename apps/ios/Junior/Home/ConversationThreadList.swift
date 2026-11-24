import JuniorKit
import SwiftUI

// The first level lines up with the card's title (12pt padding, 32pt tile,
// 12pt gap); each deeper level steps in 16pt, as `DEPTH_INDENT` does.
private let threadIndentBase: CGFloat = 56
private let threadIndentStep: CGFloat = 16

/// The Threads under one home card (`ConversationSidebarThreadRow.tsx`): a
/// status icon, the title, and the time, indented by depth, then "Show N
/// more" when the card collapses some.
struct ConversationThreadList: View {
  let threads: ThreadRows
  let expanded: Bool
  let onToggle: () -> Void

  var body: some View {
    VStack(spacing: 2) {
      ForEach(threads.rows) { ThreadRowView(row: $0) }
      if threads.collapsible && (expanded || threads.hiddenCount > 0) {
        Button(action: onToggle) {
          HStack(spacing: 8) {
            Icon("chevron-right", size: 14)
              .rotationEffect(.degrees(expanded ? 90 : 0))
            Text(expanded ? "Show fewer" : "Show \(threads.hiddenCount) more").type(.xs)
            Spacer(minLength: 0)
          }
          .foregroundStyle(Tokens.textFaint)
          .padding(.leading, threadIndentBase)
          .padding(.trailing, 12)
          .padding(.vertical, 4)
          .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(pressedFill: Tokens.fillSoft))
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
      }
    }
    .padding(.bottom, 6)
  }
}

private struct ThreadRowView: View {
  @Environment(AppModel.self) private var app
  @Environment(WindowModel.self) private var window
  let row: ThreadRow

  private var conversation: MCPConversation { row.conversation }
  private var route: Route { .conversation(conversation.conversationId) }
  private var selected: Bool { window.path.first == route }

  var body: some View {
    Button {
      window.path = [route]
    } label: {
      HStack(spacing: 8) {
        statusIcon
        Text(conversation.title)
          .type(.sm, selected ? .medium : .regular)
          .foregroundStyle(selected ? Tokens.text : Tokens.textMuted)
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
        trailing
      }
      .padding(.leading, threadIndentBase + CGFloat(row.indent) * threadIndentStep)
      .padding(.trailing, 12)
      .padding(.vertical, 4)
      .background(selected ? Tokens.surfaceActive : .clear, in: RoundedRectangle(cornerRadius: 6))
      .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle(radius: 6, pressedFill: Tokens.fillSoft))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityText)
    .accessibilityAddTraits(.isButton)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityAction { window.path = [route] }
  }

  private var accessibilityText: String {
    var parts = [conversation.title, "Thread", statusLabel]
    if conversation.turnActive, conversation.status != .working { parts.append("Working") }
    return parts.joined(separator: ", ")
  }

  private var statusLabel: String {
    switch conversation.status {
    case .working: "Working"
    case .needsInput: "Needs input"
    default: "Done"
    }
  }

  /// `ChildConversationStatusIcon`: a spinner, an alert, or a check.
  @ViewBuilder private var statusIcon: some View {
    switch conversation.status {
    case .working: Spinner().foregroundStyle(Tokens.textMuted)
    case .needsInput: Icon("circle-alert", size: 14).foregroundStyle(Color.palette(.amber, 400))
    default: Icon("circle-check", size: 14).foregroundStyle(Tokens.textFaint)
    }
  }

  /// A running Thread shows its spinner in place of the time. When the icon
  /// already spins, the time just goes.
  @ViewBuilder private var trailing: some View {
    if conversation.turnActive {
      if conversation.status != .working { Spinner().foregroundStyle(Tokens.textMuted) }
    } else if let date = conversation.lastSeenAt.date {
      Text(app.clock.activityDay(date)).type(.xs).monospacedDigit().foregroundStyle(Tokens.textFaint)
    }
  }
}
