import Foundation

/// One block of GitHub-flavored Markdown, as the dashboard transcript renders
/// it (react-markdown with remark-gfm and remark-breaks). Inline text stays as
/// Markdown source; `MarkdownInline` turns it into attributed text.
public indirect enum MarkdownBlock: Equatable, Sendable {
  case paragraph(String)
  case heading(level: Int, text: String)
  case code(language: String?, code: String)
  case quote([MarkdownBlock])
  case list(ordered: Bool, start: Int, items: [MarkdownListItem])
  case table(MarkdownTable)
  case rule
}

public struct MarkdownListItem: Equatable, Sendable {
  public var blocks: [MarkdownBlock]
  /// `true` or `false` for a task list item, `nil` for a plain item.
  public var checked: Bool?
}

public struct MarkdownTable: Equatable, Sendable {
  public enum Alignment: Equatable, Sendable { case leading, center, trailing }
  public var header: [String]
  public var alignments: [Alignment]
  public var rows: [[String]]
}

/// Parse Markdown into blocks. Single newlines inside a paragraph are kept as
/// hard breaks, as `remark-breaks` does on the web. A top-level paragraph
/// that leads with a bold-only line gets that line as a heading.
public func parseMarkdown(_ source: String) -> [MarkdownBlock] {
  splitBoldLead(parseBlocks(source))
}

/// Parse blocks without the top-level section-label rule (list items, quotes).
func parseBlocks(_ source: String) -> [MarkdownBlock] {
  let lines = source.replacingOccurrences(of: "\r\n", with: "\n")
    .split(separator: "\n", omittingEmptySubsequences: false)
    .map(String.init)
  var parser = BlockParser(lines: lines)
  return parser.parse()
}

private struct BlockParser {
  let lines: [String]
  var index = 0

  mutating func parse() -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    while index < lines.count {
      let line = lines[index]
      if line.trimmingCharacters(in: .whitespaces).isEmpty {
        index += 1
        continue
      }
      if let fence = Self.fence(line) {
        blocks.append(parseCode(fence))
      } else if let heading = Self.heading(line) {
        blocks.append(heading)
        index += 1
      } else if Self.isRule(line) {
        blocks.append(.rule)
        index += 1
      } else if Self.isQuote(line) {
        blocks.append(parseQuote())
      } else if Self.listMarker(line) != nil {
        blocks.append(parseList())
      } else if index + 1 < lines.count, line.contains("|"),
        let alignments = Self.tableSeparator(lines[index + 1]),
        alignments.count == Self.splitRow(line).count
      {
        blocks.append(parseTable(alignments))
      } else {
        blocks.append(parseParagraph())
      }
    }
    return blocks
  }

  // MARK: Code

  struct Fence {
    let marker: String
    let indent: Int
    let language: String?
  }

  static func fence(_ line: String) -> Fence? {
    let indent = line.prefix { $0 == " " }.count
    guard indent < 4 else { return nil }
    let rest = line.dropFirst(indent)
    for char in ["`", "~"] {
      let run = rest.prefix { String($0) == char }.count
      if run >= 3 {
        let info = rest.dropFirst(run).trimmingCharacters(in: .whitespaces)
        if char == "`", info.contains("`") { return nil }
        let language = info.split(separator: " ").first.map(String.init)
        return Fence(
          marker: String(repeating: char, count: run), indent: indent,
          language: language?.isEmpty == false ? language : nil)
      }
    }
    return nil
  }

  mutating func parseCode(_ fence: Fence) -> MarkdownBlock {
    index += 1
    var body: [String] = []
    while index < lines.count {
      let line = lines[index]
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.hasPrefix(fence.marker), trimmed.allSatisfy({ String($0) == String(fence.marker.first!) }) {
        index += 1
        break
      }
      body.append(String(line.dropFirst(min(fence.indent, line.prefix { $0 == " " }.count))))
      index += 1
    }
    return .code(language: fence.language, code: body.joined(separator: "\n"))
  }

  // MARK: Headings and rules

  static func heading(_ line: String) -> MarkdownBlock? {
    let trimmed = line.drop { $0 == " " }
    let hashes = trimmed.prefix { $0 == "#" }.count
    guard (1...6).contains(hashes) else { return nil }
    let rest = trimmed.dropFirst(hashes)
    guard rest.isEmpty || rest.first == " " else { return nil }
    var text = rest.trimmingCharacters(in: .whitespaces)
    // A closing run of `#` counts only after a space (`## Using C#` keeps it).
    let closing = text.reversed().prefix { $0 == "#" }.count
    if closing == text.count {
      text = ""
    } else if closing > 0, text.dropLast(closing).last == " " {
      text = String(text.dropLast(closing))
    }
    return .heading(level: hashes, text: text.trimmingCharacters(in: .whitespaces))
  }

  static func isRule(_ line: String) -> Bool {
    let compact = line.filter { $0 != " " }
    guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
    return compact.allSatisfy { $0 == first }
  }

  // MARK: Quotes

  static func isQuote(_ line: String) -> Bool {
    line.drop { $0 == " " }.hasPrefix(">")
  }

  mutating func parseQuote() -> MarkdownBlock {
    var inner: [String] = []
    while index < lines.count {
      let line = lines[index]
      if Self.isQuote(line) {
        var rest = line.drop { $0 == " " }.dropFirst()
        if rest.first == " " { rest = rest.dropFirst() }
        inner.append(String(rest))
      } else if !line.trimmingCharacters(in: .whitespaces).isEmpty, !inner.isEmpty,
        inner.last?.trimmingCharacters(in: .whitespaces).isEmpty == false,
        Self.startsBlock(line) == false
      {
        // Lazy continuation of the quoted paragraph.
        inner.append(line)
      } else {
        break
      }
      index += 1
    }
    return .quote(parseBlocks(inner.joined(separator: "\n")))
  }

  // MARK: Lists

  struct Marker {
    let indent: Int
    let ordered: Bool
    let number: Int
    /// Column where the item content starts.
    let contentOffset: Int
  }

  static func listMarker(_ line: String) -> Marker? {
    let indent = line.prefix { $0 == " " }.count
    let rest = Array(line.dropFirst(indent))
    guard let first = rest.first else { return nil }
    if "-*+•◦".contains(first) {
      guard rest.count == 1 || rest[1] == " " else { return nil }
      if isRule(line) { return nil }
      let spaces = rest.dropFirst().prefix { $0 == " " }.count
      return Marker(indent: indent, ordered: false, number: 1, contentOffset: indent + 1 + max(1, min(spaces, 4)))
    }
    let digits = rest.prefix { $0.isNumber }
    guard !digits.isEmpty, digits.count <= 9, rest.count > digits.count else { return nil }
    let delimiter = rest[digits.count]
    guard delimiter == "." || delimiter == ")" else { return nil }
    guard rest.count == digits.count + 1 || rest[digits.count + 1] == " " else { return nil }
    let spaces = rest.dropFirst(digits.count + 1).prefix { $0 == " " }.count
    return Marker(
      indent: indent, ordered: true, number: Int(String(digits)) ?? 1,
      contentOffset: indent + digits.count + 1 + max(1, min(spaces, 4)))
  }

  mutating func parseList() -> MarkdownBlock {
    let first = Self.listMarker(lines[index])!
    var items: [MarkdownListItem] = []
    while index < lines.count, let marker = Self.listMarker(lines[index]),
      marker.ordered == first.ordered, abs(marker.indent - first.indent) <= 1
    {
      var body = [String(lines[index].dropFirst(min(marker.contentOffset, lines[index].count)))]
      index += 1
      while index < lines.count {
        let line = lines[index]
        let indent = line.prefix { $0 == " " }.count
        let blank = line.trimmingCharacters(in: .whitespaces).isEmpty
        if blank {
          // Keep a blank line only when the item continues after it.
          let next = lines[(index + 1)...].first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
          guard let next, next.prefix(while: { $0 == " " }).count >= marker.contentOffset else { break }
          body.append("")
        } else if indent >= marker.contentOffset {
          body.append(String(line.dropFirst(marker.contentOffset)))
        } else if indent > marker.indent, Self.listMarker(line) != nil {
          // A nested list indented less than the content offset.
          body.append(String(line.dropFirst(indent)))
        } else if Self.listMarker(line) == nil, !Self.startsBlock(line), body.last?.isEmpty == false {
          body.append(line.trimmingCharacters(in: .whitespaces))
        } else {
          break
        }
        index += 1
      }
      var checked: Bool?
      if let head = body.first {
        if head.hasPrefix("[ ] ") || head == "[ ]" {
          checked = false
          body[0] = String(head.dropFirst(min(4, head.count)))
        } else if head.lowercased().hasPrefix("[x] ") || head.lowercased() == "[x]" {
          checked = true
          body[0] = String(head.dropFirst(min(4, head.count)))
        }
      }
      items.append(MarkdownListItem(blocks: parseBlocks(body.joined(separator: "\n")), checked: checked))
    }
    return .list(ordered: first.ordered, start: first.number, items: items)
  }

  // MARK: Tables

  static func tableSeparator(_ line: String) -> [MarkdownTable.Alignment]? {
    let cells = splitRow(line)
    guard !cells.isEmpty else { return nil }
    var alignments: [MarkdownTable.Alignment] = []
    for cell in cells {
      let trimmed = cell.trimmingCharacters(in: .whitespaces)
      let core = trimmed.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
      guard !core.isEmpty, core.allSatisfy({ $0 == "-" }) else { return nil }
      let left = trimmed.hasPrefix(":")
      let right = trimmed.hasSuffix(":")
      alignments.append(left && right ? .center : right ? .trailing : .leading)
    }
    return alignments
  }

  static func splitRow(_ line: String) -> [String] {
    var trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.hasPrefix("|") { trimmed.removeFirst() }
    if trimmed.hasSuffix("|"), !trimmed.hasSuffix("\\|") { trimmed.removeLast() }
    var cells: [String] = []
    var current = ""
    var inCode = false
    var previous: Character?
    for char in trimmed {
      if char == "`" { inCode.toggle() }
      if char == "|", !inCode, previous != "\\" {
        cells.append(current.trimmingCharacters(in: .whitespaces))
        current = ""
      } else {
        current.append(char)
      }
      previous = char
    }
    cells.append(current.trimmingCharacters(in: .whitespaces))
    return cells.map { $0.replacingOccurrences(of: "\\|", with: "|") }
  }

  mutating func parseTable(_ alignments: [MarkdownTable.Alignment]) -> MarkdownBlock {
    let header = Self.splitRow(lines[index])
    index += 2
    var rows: [[String]] = []
    while index < lines.count {
      let line = lines[index]
      guard line.contains("|"), !line.trimmingCharacters(in: .whitespaces).isEmpty else { break }
      var row = Self.splitRow(line)
      if row.count < header.count { row += Array(repeating: "", count: header.count - row.count) }
      rows.append(Array(row.prefix(header.count)))
      index += 1
    }
    let columns = header.count
    let aligned = Array((alignments + Array(repeating: .leading, count: columns)).prefix(columns))
    return .table(MarkdownTable(header: header, alignments: aligned, rows: rows))
  }

  // MARK: Paragraphs

  static func startsBlock(_ line: String) -> Bool {
    fence(line) != nil || heading(line) != nil || isQuote(line) || isRule(line)
      || listMarker(line) != nil
  }

  /// A paragraph, or a setext heading (`Title` over `===` or `---`).
  mutating func parseParagraph() -> MarkdownBlock {
    var text: [String] = []
    while index < lines.count {
      let line = lines[index]
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.isEmpty { break }
      if !text.isEmpty {
        if trimmed.allSatisfy({ $0 == "=" }) || (trimmed.allSatisfy({ $0 == "-" }) && trimmed.count >= 2) {
          index += 1
          return .heading(level: trimmed.first == "=" ? 1 : 2, text: text.joined(separator: " "))
        }
        // Only an ordered list that starts at 1 may interrupt a paragraph.
        if let marker = Self.listMarker(line), marker.ordered, marker.number != 1 {
          text.append(trimmed)
          index += 1
          continue
        }
        if Self.startsBlock(line) { break }
        if line.contains("|"), index + 1 < lines.count,
          let alignments = Self.tableSeparator(lines[index + 1]), alignments.count == Self.splitRow(line).count
        {
          break
        }
      }
      text.append(trimmed)
      index += 1
    }
    return .paragraph(text.joined(separator: "\n"))
  }
}

/// A paragraph that leads with a line of only bold text reads as a heading
/// (`display-text/markdown.tsx`); the rest stays a paragraph.
func splitBoldLead(_ blocks: [MarkdownBlock]) -> [MarkdownBlock] {
  blocks.flatMap { block -> [MarkdownBlock] in
    guard case .paragraph(let text) = block else { return [block] }
    let lines = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
    var head = String(lines[0])
    // `**Gaps**:` counts too, and keeps its colon.
    let colon = head.hasSuffix("**:")
    if colon { head.removeLast() }
    guard head.hasPrefix("**"), head.hasSuffix("**"), head.count > 4,
      !head.dropFirst(2).dropLast(2).contains("**")
    else { return [block] }
    let heading = MarkdownBlock.heading(
      level: 3, text: String(head.dropFirst(2).dropLast(2)) + (colon ? ":" : ""))
    return lines.count > 1 ? [heading, .paragraph(String(lines[1]))] : [heading]
  }
}
