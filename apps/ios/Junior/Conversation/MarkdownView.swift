import JuniorKit
import SwiftUI

/// Message body Markdown (`display-text/markdown.tsx`): 16pt Inter with a
/// 1.625 line height, 12pt between blocks.
struct MarkdownView: View {
  let blocks: [MarkdownBlock]
  var step: TextStep = .base
  var color: Color = Tokens.text
  /// 12pt between blocks; 6pt inside a list item (`li > * + *`).
  var spacing: CGFloat = 12

  init(_ source: String, step: TextStep = .base, color: Color = Tokens.text) {
    self.blocks = parseMarkdown(source)
    self.step = step
    self.color = color
  }

  init(blocks: [MarkdownBlock], step: TextStep, color: Color, spacing: CGFloat = 12) {
    self.blocks = blocks
    self.step = step
    self.color = color
    self.spacing = spacing
  }

  var body: some View {
    VStack(alignment: .leading, spacing: spacing) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        BlockView(block: block, step: step, color: color)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct BlockView: View {
  let block: MarkdownBlock
  let step: TextStep
  let color: Color

  var body: some View {
    switch block {
    case .paragraph(let text):
      // A paragraph that is one bold line reads as a heading.
      if text.hasPrefix("**"), text.hasSuffix("**"), !text.contains("\n"), text.count > 4,
        !text.dropFirst(2).dropLast(2).contains("**")
      {
        heading(String(text.dropFirst(2).dropLast(2)), level: 3)
      } else {
        prose(text)
      }
    case .heading(let level, let text):
      heading(text, level: level)
    case .code(let language, let code):
      CodeBlockView(code: code, language: language)
    case .quote(let inner):
      MarkdownView(blocks: inner, step: step, color: Tokens.textMuted)
        .padding(.leading, 12)
        .overlay(alignment: .leading) { Rectangle().fill(Tokens.border).frame(width: 2) }
    case .list(let ordered, let start, let items):
      ListBlockView(ordered: ordered, start: start, items: items, step: step, color: color)
    case .table(let table):
      TableBlockView(table: table)
    case .rule:
      Rectangle().fill(Tokens.border).frame(height: 1).padding(.vertical, 4)
    }
  }

  private func prose(_ text: String) -> some View {
    Text(styledInline(text, step: step, color: color))
      .type(step, lineHeight: 1.625)
      .fixedSize(horizontal: false, vertical: true)
      .textSelection(.enabled)
  }

  private func heading(_ text: String, level: Int) -> some View {
    let size: TextStep = level <= 2 ? .lg : step
    return Text(styledInline(text, step: size, color: Tokens.text))
      .type(size, .semibold)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityAddTraits(.isHeader)
  }
}

private struct ListBlockView: View {
  let ordered: Bool
  let start: Int
  let items: [MarkdownListItem]
  let step: TextStep
  let color: Color

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(Array(items.enumerated()), id: \.offset) { index, item in
        HStack(alignment: .firstTextBaseline, spacing: 0) {
          marker(index, item)
            .frame(width: 24, alignment: ordered ? .trailing : .center)
            .padding(.trailing, ordered ? 6 : 2)
          MarkdownView(blocks: item.blocks, step: step, color: color, spacing: 6)
        }
      }
    }
  }

  @ViewBuilder private func marker(_ index: Int, _ item: MarkdownListItem) -> some View {
    if let checked = item.checked {
      Icon(checked ? "checkmark.square.fill" : "square", size: 14)
        .foregroundStyle(checked ? Tokens.accent : Tokens.textMuted)
    } else if ordered {
      Text("\(start + index).")
        .type(step)
        .monospacedDigit()
        .foregroundStyle(Tokens.textMuted)
    } else {
      Text("•")
        .type(step)
        .foregroundStyle(Tokens.textMuted)
    }
  }
}

/// Fenced code: wraps lines, GitHub dark/light colors, copy button.
struct CodeBlockView: View {
  let code: String
  let language: String?
  @State private var copied = false

  var body: some View {
    Text(highlighted)
      .type(.sm, family: .mono, lineHeight: 1.625)
      .fixedSize(horizontal: false, vertical: true)
      .textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 10)
      .padding(.leading, 12)
      .padding(.trailing, 40)
      .panelCard(radius: 6)
      .overlay(alignment: .topTrailing) {
        Button {
          UIPasteboard.general.string = code
          copied = true
          Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
          }
        } label: {
          Icon(copied ? "check" : "copy", size: 14)
            .foregroundStyle(Tokens.textMuted)
            .frame(width: 32, height: 32)
        }
        .buttonStyle(PressableStyle(radius: 6))
        .padding(4)
        .accessibilityLabel(copied ? "Copied" : "Copy code")
      }
  }

  private var highlighted: AttributedString {
    var output = AttributedString()
    for token in highlightCode(code, language: language) {
      var run = AttributedString(token.text)
      run.foregroundColor = CodeColors.color(token.kind)
      output += run
    }
    return output
  }
}

/// Shiki `github-dark` / `github-light` token colors.
enum CodeColors {
  static func color(_ kind: CodeTokenKind) -> Color {
    switch kind {
    case .plain: Tokens.dynamic(dark: 0xE1E4E8, light: 0x24292E)
    case .keyword: Tokens.dynamic(dark: 0xF97583, light: 0xD73A49)
    case .string: Tokens.dynamic(dark: 0x9ECBFF, light: 0x032F62)
    case .number, .property: Tokens.dynamic(dark: 0x79B8FF, light: 0x005CC5)
    case .comment: Tokens.dynamic(dark: 0x6A737D, light: 0x6A737D)
    case .function, .type: Tokens.dynamic(dark: 0xB392F0, light: 0x6F42C1)
    }
  }
}

/// GFM table: bordered, horizontally scrolling, cells sized to content.
private struct TableBlockView: View {
  let table: MarkdownTable

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
        GridRow {
          ForEach(Array(table.header.enumerated()), id: \.offset) { column, cell in
            Text(styledInline(cell, step: .xs, color: Tokens.textMuted))
              .type(.xs, .medium)
              .lineLimit(1)
              .fixedSize()
              .padding(.horizontal, 10)
              .padding(.vertical, 6)
              .frame(maxWidth: .infinity, alignment: alignment(column))
              .background(Tokens.overlaySoft)
          }
        }
        Rectangle().fill(Tokens.border).frame(height: 1).gridCellUnsizedAxes(.horizontal)
        ForEach(Array(table.rows.enumerated()), id: \.offset) { index, row in
          if index > 0 {
            Rectangle().fill(Tokens.borderSubtle).frame(height: 1).gridCellUnsizedAxes(.horizontal)
          }
          GridRow {
            ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
              Text(styledInline(cell, step: .sm, color: Tokens.text))
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: alignment(column))
            }
          }
        }
      }
    }
    .background(Tokens.fillFaint)
    .clipShape(RoundedRectangle(cornerRadius: 6))
    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.border))
  }

  private func alignment(_ column: Int) -> Alignment {
    switch table.alignments.indices.contains(column) ? table.alignments[column] : .leading {
    case .leading: .leading
    case .center: .center
    case .trailing: .trailing
    }
  }
}
