import JuniorKit
import SwiftUI

/// One transcript message (`TranscriptMessageShell.tsx`): 24pt avatar column,
/// name and time, Markdown body, and the Turn's memory chip.
struct MessageRow: View {
  @Environment(AppModel.self) private var app
  let message: TranscriptMessage
  let slackSurface: Bool
  /// Fork after this reply, when the Conversation allows it.
  var onFork: (() -> Void)?
  @State private var copied = false

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      avatar.padding(.top, 4)
      VStack(alignment: .leading, spacing: 8) {
        header
        if message.redacted {
          Text("This message is hidden.")
            .type(.sm)
            .italic()
            .foregroundStyle(Tokens.textMuted)
        } else if !message.text.isEmpty {
          MarkdownView(message.text)
        }
        if !message.attachments.isEmpty {
          FlowRow(items: message.attachments) { name in
            TagChip(label: name, maxWidth: 220) { Icon("file-text", size: 12).foregroundStyle(Tokens.textMuted) }
          }
        }
        if message.recalledMemories > 0 {
          MemoryChip(count: message.recalledMemories)
        }
        if case .agent = message.speaker, !message.text.isEmpty {
          actions
        }
      }
      .padding(.vertical, 4)
    }
    .padding(.vertical, 6)
    .accessibilityElement(children: .contain)
  }

  /// Reply actions, always shown on touch: Copy, and Fork when allowed.
  private var actions: some View {
    HStack(spacing: 0) {
      Button {
        UIPasteboard.general.string = message.text
        copied = true
        Task {
          try? await Task.sleep(for: .seconds(2))
          copied = false
        }
      } label: {
        Icon(copied ? "check" : "copy", size: 14).frame(width: 32, height: 32).hitArea()
      }
      .accessibilityLabel(copied ? "Copied" : "Copy message")
      if let onFork {
        Button(action: onFork) {
          Icon("git-fork", size: 14).frame(width: 32, height: 32).hitArea()
        }
        .accessibilityLabel("Fork after this message")
      }
    }
    .buttonStyle(PressableStyle(radius: 6))
    .foregroundStyle(Tokens.textMuted)
    .padding(.leading, -9)
    .padding(.vertical, -6)
  }

  @ViewBuilder private var avatar: some View {
    switch message.speaker {
    case .agent: Avatar(kind: .agent)
    case .parentAgent: Avatar(kind: .parentAgent)
    case .person(let identity): Avatar(kind: .person(identity))
    case .system: Avatar(kind: .person(ActorIdentity(fullName: "System")))
    case .event: Avatar(kind: .event)
    }
  }

  private var name: (String, Color) {
    switch message.speaker {
    case .agent: (app.agentName, Tokens.accentText)
    case .parentAgent: ("Parent agent", Tokens.text)
    case .person(let identity): (identity?.displayName ?? "User", Tokens.text)
    case .system: ("System", Color.palette(.amber, 200))
    case .event(let type): (type.contains("automation") ? "Automation" : "Event", Tokens.text)
    }
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(name.0)
        .type(.sm, .semibold)
        .foregroundStyle(name.1)
      HStack(spacing: 6) {
        if slackSurface, message.fromSlack {
          PathIcon.slack(size: 12)
          Text("·")
        }
        if let date = message.createdAt {
          Text(app.clock.messageTime(date))
        }
        if let postedTo = message.postedTo {
          Text("· posted to \(postedTo.capitalized)")
        }
      }
      .type(.xs)
      .foregroundStyle(Tokens.textMuted)
    }
    .frame(minHeight: 24)
    .accessibilityElement(children: .combine)
  }

}

/// "Recalled N memories" chip.
struct MemoryChip: View {
  let count: Int

  var body: some View {
    HStack(spacing: 6) {
      Icon("history", size: 14).foregroundStyle(Tokens.textFaint)
      Text("Recalled \(count) \(count == 1 ? "memory" : "memories")")
    }
    .type(.xs)
    .foregroundStyle(Tokens.textMuted)
    .padding(.horizontal, 8)
    .frame(minHeight: 24)
    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.border))
  }
}

/// Folded reasoning and tool calls: "2 events · 5.0s", or the live
/// "Working for …" block with the latest reasoning and the running tool.
struct ActivityRow: View {
  @Environment(AppModel.self) private var app
  let activity: TranscriptActivity
  @State private var open = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        withAnimation(.snappy(duration: 0.2)) { open.toggle() }
      } label: {
        HStack(spacing: 4) {
          label
          Icon("chevron-right", size: 12)
            .opacity(0.55)
            .rotationEffect(.degrees(open ? 90 : 0))
        }
        .type(.xs)
        .foregroundStyle(Tokens.textMuted)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
      }
      .buttonStyle(PressableStyle(radius: 6))
      .padding(.horizontal, -8)
      .accessibilityHint(open ? "Hides the steps" : "Shows the steps")

      if open {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(activity.entries) { entry in
            EntryLine(entry: entry)
          }
        }
      } else if activity.isLive {
        if let reasoning = activity.latestReasoning {
          Text(styledInline(reasoning, step: .sm, color: Tokens.textMuted))
            .type(.sm, lineHeight: 1.625)
            .lineLimit(3)
            .transition(.opacity)
        }
        LiveStatusLine(tool: activity.runningTool)
      }
    }
    .padding(.leading, 32)
    .padding(.vertical, 4)
  }

  @ViewBuilder private var label: some View {
    if activity.isLive {
      if let fixed = app.fixedNow {
        Text("Working for \(liveTime(at: fixed))")
      } else {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          Text("Working for \(liveTime(at: context.date))")
        }
      }
    } else {
      Text(open ? "Hide \(activity.summary)" : activity.summary)
    }
  }

  private func liveTime(at now: Date) -> String {
    guard let start = activity.startedAt else { return "0s" }
    return formatLiveDuration(max(0, Int(now.timeIntervalSince(start))))
  }
}

private struct LiveStatusLine: View {
  let tool: ActivityEntry?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var shimmer = false

  var body: some View {
    HStack(spacing: 6) {
      if case .tool(let name, let preview, _)? = tool?.kind {
        let verb = liveToolVerb(name)
        Icon(verb.symbol, size: 14).foregroundStyle(Tokens.textFaint)
        Text(verb.verb).type(.sm).foregroundStyle(Tokens.textMuted).opacity(shimmerOpacity)
        Text(preview)
          .type(.xs, family: .mono)
          .foregroundStyle(Tokens.textMuted)
          .lineLimit(1)
      } else {
        Text("Thinking").type(.sm).foregroundStyle(Tokens.textMuted).opacity(shimmerOpacity)
      }
    }
    .onAppear { shimmer = true }
    .animation(reduceMotion ? nil : .easeInOut(duration: 1.1).repeatForever(), value: shimmer)
    .accessibilityElement(children: .combine)
  }

  private var shimmerOpacity: Double { reduceMotion || !shimmer ? 1 : 0.55 }
}

private struct EntryLine: View {
  let entry: ActivityEntry

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      switch entry.kind {
      case .reasoning(let text):
        Icon("lightbulb", size: 13).foregroundStyle(Color.palette(.violet, 200))
        Text(text).italic().lineLimit(1).foregroundStyle(Tokens.textMuted)
      case .tool(let name, let preview, let state):
        Icon("wrench", size: 13).foregroundStyle(Tokens.textFaint)
        (Text(name).font(.dashboard(.xs, .semibold))
          .foregroundStyle(state == .error ? Color.palette(.rose, 300) : Tokens.text)
          + Text(preview.isEmpty ? "" : " (\(preview))").foregroundStyle(Tokens.textMuted))
          .lineLimit(1)
      case .note(let text):
        Icon("message-square", size: 13).foregroundStyle(Tokens.textFaint)
        Text(plainText(fromMarkdown: text)).lineLimit(1).foregroundStyle(Tokens.textMuted)
      }
    }
    .type(.xs)
  }
}

/// A failed Turn (`TranscriptFailureView.tsx`).
struct FailureRow: View {
  let failure: TranscriptFailure

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Icon("circle-alert", size: 16).foregroundStyle(Color.palette(.rose, 300))
      VStack(alignment: .leading, spacing: 4) {
        Text(failure.title).type(.base, .semibold, family: .display).foregroundStyle(Tokens.text)
        if let detail = failure.detail {
          Text(detail).type(.sm).foregroundStyle(Color.palette(.rose, 100).opacity(0.7))
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .background(Color.palette(.rose, 300).opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    .padding(.leading, 32)
    .padding(.vertical, 6)
  }
}

/// A Thread started by this Conversation.
struct ThreadCard: View {
  @Environment(AppModel.self) private var app
  let thread: TranscriptThread

  var body: some View {
    Button {
      if let id = thread.conversationId { app.path.append(.conversation(id)) }
    } label: {
      HStack(spacing: 8) {
        Text(thread.title).type(.sm, .medium).foregroundStyle(Tokens.text).lineLimit(1)
        if let status = thread.status {
          Text(status.capitalized)
            .type(.xxs, .medium)
            .foregroundStyle(Tokens.textMuted)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Tokens.fillStrong, in: Capsule())
        }
        Spacer(minLength: 0)
        Icon("chevron-right", size: 12).foregroundStyle(Tokens.textMuted)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .panelCard()
    }
    .buttonStyle(PressableStyle())
    .padding(.leading, 32)
    .padding(.vertical, 6)
  }
}

/// "Junior is thinking…" before any activity shows.
struct ThinkingRow: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    Text("\(app.agentName) is thinking…")
      .type(.sm)
      .foregroundStyle(Tokens.textMuted)
      .padding(.leading, 32)
      .padding(.vertical, 8)
  }
}

/// Wrap items onto as many lines as they need.
struct FlowRow<Item: Hashable, Content: View>: View {
  let items: [Item]
  @ViewBuilder var content: (Item) -> Content

  var body: some View {
    FlowLayout(spacing: 6) {
      ForEach(items, id: \.self) { content($0) }
    }
  }
}

struct FlowLayout: Layout {
  var spacing: CGFloat
  var lineSpacing: CGFloat?

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0
    var y: CGFloat = 0
    var row: CGFloat = 0
    for view in subviews {
      let size = Self.size(of: view, width: width)
      if x > 0, x + size.width > width {
        y += row + (lineSpacing ?? spacing)
        x = 0
        row = 0
      }
      x += size.width + spacing
      row = max(row, size.height)
    }
    return CGSize(width: width == .infinity ? x : width, height: y + row)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX
    var y = bounds.minY
    var row: CGFloat = 0
    for view in subviews {
      let size = Self.size(of: view, width: bounds.width)
      if x > bounds.minX, x + size.width > bounds.maxX {
        y += row + (lineSpacing ?? spacing)
        x = bounds.minX
        row = 0
      }
      view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      row = max(row, size.height)
    }
  }

  /// An item's natural size, wrapped to the row when it is wider.
  private static func size(of view: LayoutSubview, width: CGFloat) -> CGSize {
    let ideal = view.sizeThatFits(.unspecified)
    guard width.isFinite, ideal.width > width else { return ideal }
    return view.sizeThatFits(ProposedViewSize(width: width, height: nil))
  }
}

/// Files Junior delivered to the Location.
struct DeliveredRow: View {
  let delivery: TranscriptDelivery

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Delivered \(delivery.filenames.count == 1 ? "1 file" : "\(delivery.filenames.count) files")")
        .type(.xs)
        .foregroundStyle(Tokens.textMuted)
      FlowRow(items: delivery.filenames) { name in
        TagChip(label: name, maxWidth: 220) { Icon("file-text", size: 12).foregroundStyle(Tokens.textMuted) }
      }
    }
    .padding(.leading, 32)
    .padding(.vertical, 6)
  }
}
