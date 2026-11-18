import JuniorKit
import SwiftUI

/// One transcript message (`TranscriptMessageShell.tsx`): 24pt avatar column,
/// name and time, and the Markdown body. The public API carries user and
/// assistant messages only, not tool calls.
struct MessageRow: View {
  @Environment(AppModel.self) private var app
  let message: MCPMessage
  /// Parsed body, when the caller keeps a cache; parsed here otherwise.
  var blocks: [MarkdownBlock]? = nil
  @State private var copied = false

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      avatar.padding(.top, 4)
      VStack(alignment: .leading, spacing: 8) {
        header
        if !message.text.isEmpty {
          MarkdownView(blocks: blocks ?? parseMarkdown(message.text), step: .base, color: Tokens.text)
        }
        if let attachments = message.attachments, !attachments.isEmpty {
          FlowRow(items: attachments.map(\.filename)) { name in
            TagChip(label: name, maxWidth: 220) { Icon("file-text", size: 12).foregroundStyle(Tokens.textMuted) }
          }
        }
        if message.isAssistant, !message.text.isEmpty {
          copyButton
        }
      }
      .padding(.vertical, 4)
    }
    .padding(.vertical, 6)
    .accessibilityElement(children: .contain)
  }

  private var copyButton: some View {
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
    .buttonStyle(PressableStyle(radius: 6))
    .foregroundStyle(Tokens.textMuted)
    .padding(.leading, -9)
    .padding(.vertical, -6)
  }

  @ViewBuilder private var avatar: some View {
    if message.isAssistant { Avatar(kind: .agent) } else { Avatar(kind: .person(message.author)) }
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(message.isAssistant ? app.agentName : message.author ?? "User")
        .type(.sm, .semibold)
        .foregroundStyle(message.isAssistant ? Tokens.accentText : Tokens.text)
      if let date = message.createdAt.date {
        Text(app.clock.messageTime(date)).type(.xs).foregroundStyle(Tokens.textMuted)
      }
    }
    .frame(minHeight: 24)
    .accessibilityElement(children: .combine)
  }
}

/// "Junior is working…" while a Turn runs.
struct WorkingRow: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    HStack(spacing: 8) {
      Spinner().foregroundStyle(Tokens.textMuted)
      Text("\(app.agentName) is working…").type(.sm).foregroundStyle(Tokens.textMuted)
    }
    .padding(.leading, 32)
    .padding(.vertical, 8)
    .accessibilityElement(children: .combine)
  }
}

/// The last Turn failed or was stopped (`TranscriptFailureView.tsx`). The
/// public API has the status, not the failure's details.
struct EndedRow: View {
  @Environment(AppModel.self) private var app
  let status: ConversationStatus

  var body: some View {
    let failed = status == .failed
    HStack(alignment: .top, spacing: 8) {
      Icon(failed ? "circle-alert" : "circle-stop", size: 16)
        .foregroundStyle(failed ? Color.palette(.rose, 400) : Tokens.textMuted)
        .frame(width: 24, height: 24)
      VStack(alignment: .leading, spacing: 2) {
        Text(failed ? "Turn failed" : "Stopped").type(.sm, .semibold).foregroundStyle(Tokens.text)
        Text(
          failed
            ? "\(app.agentName) could not finish this turn. Send a message to try again."
            : "Send a message to continue."
        )
        .type(.xs).foregroundStyle(Tokens.textMuted)
      }
    }
    .padding(.vertical, 8)
    .accessibilityElement(children: .combine)
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
