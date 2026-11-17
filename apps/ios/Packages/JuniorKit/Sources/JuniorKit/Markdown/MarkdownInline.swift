import Foundation

/// Parse inline Markdown (emphasis, strong, strikethrough, code, links) into
/// an attributed string. Runs keep Foundation's `inlinePresentationIntent`
/// and `link` attributes; the app maps them to dashboard fonts and colors.
/// Newlines stay as hard breaks, as `remark-breaks` renders them.
public func parseInlineMarkdown(_ source: String) -> AttributedString {
  let source = normalizeSlackLinks(source)
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

/// Turn Slack links (`<url|label>`, `<url>`) into Markdown links, as the
/// dashboard renders text that came from Slack.
func normalizeSlackLinks(_ text: String) -> String {
  guard text.contains("<") else { return text }
  var output = text
  let labeled = /<((?:https?|mailto):[^|>\s]+)\|([^>]+)>/
  output = output.replacing(labeled) { match in "[\(match.2)](\(match.1))" }
  let bare = /<((?:https?|mailto):[^>\s]+)>/
  output = output.replacing(bare) { match in String(match.1) }
  return output
}
