import Foundation

/// Parse inline Markdown (emphasis, strong, strikethrough, code, links) into
/// an attributed string. Runs keep Foundation's `inlinePresentationIntent`
/// and `link` attributes; the app maps them to dashboard fonts and colors.
/// Newlines stay as hard breaks, as `remark-breaks` renders them.
public func parseInlineMarkdown(_ source: String) -> AttributedString {
  let options = AttributedString.MarkdownParsingOptions(
    allowsExtendedAttributes: false,
    interpretedSyntax: .inlineOnlyPreservingWhitespace,
    failurePolicy: .returnPartiallyParsedIfPossible)
  return (try? AttributedString(markdown: source, options: options)) ?? AttributedString(source)
}

/// Markdown reduced to its readable text, for previews and accessibility.
public func plainText(fromMarkdown source: String) -> String {
  var parts: [String] = []
  func walk(_ blocks: [MarkdownBlock]) {
    for block in blocks {
      switch block {
      case .paragraph(let text), .heading(_, let text):
        parts.append(String(parseInlineMarkdown(text).characters))
      case .code(_, let code):
        parts.append(code)
      case .quote(let inner):
        walk(inner)
      case .list(_, _, let items):
        for item in items { walk(item.blocks) }
      case .table(let table):
        parts.append(table.header.joined(separator: " "))
        for row in table.rows { parts.append(row.joined(separator: " ")) }
      case .rule:
        break
      }
    }
  }
  walk(parseMarkdown(source))
  return parts.joined(separator: "\n")
}
