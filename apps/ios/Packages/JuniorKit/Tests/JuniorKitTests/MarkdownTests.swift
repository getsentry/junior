import Foundation
import Testing

@testable import JuniorKit

@Suite struct MarkdownTests {
  @Test func parsesTranscriptReply() {
    let source = """
      Checkout p95 jumped after **payments-v42** landed.

      What I checked:
      - deploy marker `payments-v42` correlates with the spike
      - error volume is flat

      | Window | p95 | Notes |
      | --- | ---: | --- |
      | pre-deploy | 210ms | baseline |
      | post-deploy | **890ms** | spike |

      ```sql
      SELECT 1
      FROM t;
      ```

      Next step: compare spans, then decide whether to
      roll back.
      """
    let blocks = parseMarkdown(source)
    #expect(blocks.count == 6)
    #expect(blocks[0] == .paragraph("Checkout p95 jumped after **payments-v42** landed."))
    guard case .list(false, _, let items) = blocks[2] else {
      Issue.record("expected a bullet list")
      return
    }
    #expect(items.count == 2)
    guard case .table(let table) = blocks[3] else {
      Issue.record("expected a table")
      return
    }
    #expect(table.header == ["Window", "p95", "Notes"])
    #expect(table.alignments == [.leading, .trailing, .leading])
    #expect(table.rows[1] == ["post-deploy", "**890ms**", "spike"])
    #expect(blocks[4] == .code(language: "sql", code: "SELECT 1\nFROM t;"))
    #expect(blocks[5] == .paragraph("Next step: compare spans, then decide whether to\nroll back."))
  }

  @Test func nestsListsUnderOrderedItems() {
    let blocks = parseMarkdown(
      """
      1. `checkout.complete` p95
         - stable hosts
         - canary hosts
      2. ~~error rate~~ serializer span time
      """)
    guard case .list(true, 1, let items) = blocks.first else {
      Issue.record("expected an ordered list")
      return
    }
    #expect(items.count == 2)
    #expect(items[0].blocks.count == 2)
    guard case .list(false, _, let nested) = items[0].blocks[1] else {
      Issue.record("expected a nested bullet list")
      return
    }
    #expect(nested.count == 2)
  }

  @Test func parsesQuotesAndTaskItems() {
    let blocks = parseMarkdown("> error volume is flat\n> so slow path\n\n- [x] done\n- [ ] open")
    #expect(blocks[0] == .quote([.paragraph("error volume is flat\nso slow path")]))
    guard case .list(_, _, let items) = blocks[1] else {
      Issue.record("expected a task list")
      return
    }
    #expect(items.map(\.checked) == [true, false])
  }

  @Test func inlineKeepsCodeAndStrong() {
    let text = parseInlineMarkdown("after **payments-v42** and `x`")
    #expect(String(text.characters) == "after payments-v42 and x")
    let strong = text.runs.contains { $0.inlinePresentationIntent == .stronglyEmphasized }
    let code = text.runs.contains { $0.inlinePresentationIntent == .code }
    #expect(strong && code)
  }

  @Test func highlightsSQL() {
    let tokens = highlightCode("SELECT p95 FROM t WHERE a = 'x' -- note", language: "sql")
    #expect(tokens.first == CodeToken(text: "SELECT", kind: .keyword))
    #expect(tokens.contains(CodeToken(text: "'x'", kind: .string)))
    #expect(tokens.last == CodeToken(text: "-- note", kind: .comment))
  }
}

@Suite struct MarkdownEdgeTests {
  @Test func keepsHashInHeading() {
    #expect(parseMarkdown("## Using C#") == [.heading(level: 2, text: "Using C#")])
    #expect(parseMarkdown("## Done ##") == [.heading(level: 2, text: "Done")])
  }

  @Test func readsSetextHeadings() {
    #expect(parseMarkdown("Title\n===") == [.heading(level: 1, text: "Title")])
    #expect(parseMarkdown("Sub\n---") == [.heading(level: 2, text: "Sub")])
  }

  @Test func needsMatchingTableColumns() {
    #expect(parseMarkdown("a | b\n---") == [.heading(level: 2, text: "a | b")])
  }

  @Test func onlyOneInterruptsParagraph() {
    #expect(parseMarkdown("Shipped in\n2024. It worked.") == [.paragraph("Shipped in\n2024. It worked.")])
  }

  @Test func readsBulletDots() {
    guard case .list(false, _, let items) = parseMarkdown("• one\n• two").first else {
      Issue.record("expected a list")
      return
    }
    #expect(items.count == 2)
  }

  @Test func boldLeadBecomesHeading() {
    #expect(parseMarkdown("**Summary**\nAll good.") == [.heading(level: 3, text: "Summary"), .paragraph("All good.")])
  }

  @Test func readsSlackLinks() {
    let text = parseInlineMarkdown("see <https://x.dev/a|the PR> and <https://y.dev>")
    #expect(String(text.characters) == "see the PR and https://y.dev")
    #expect(text.runs.contains { $0.link?.absoluteString == "https://x.dev/a" })
  }
}

@Suite struct ClientTests {
  @Test func encodesPlusAndKeepsEscapedPaths() throws {
    let client = JuniorClient(server: JuniorServer(baseURL: URL(string: "http://h/")!))
    let url = try client.requestURL(
      "/api/conversations/slack%3AC1%3A1.2", query: [URLQueryItem(name: "q", value: "C++ a&b")])
    #expect(url.absoluteString == "http://h/api/conversations/slack%3AC1%3A1.2?q=C%2B%2B%20a%26b")
  }
}

@Suite struct MarkdownSecondPassTests {
  @Test func sectionLabelOnlyAtTopLevel() {
    #expect(parseMarkdown("**Gaps**:\nNone left.") == [.heading(level: 3, text: "Gaps:"), .paragraph("None left.")])
    guard case .list(true, _, let items) = parseMarkdown("1. **Install**\n   Run npm install.").first else {
      Issue.record("expected a list")
      return
    }
    #expect(items[0].blocks == [.paragraph("**Install**\nRun npm install.")])
  }

  @Test func slackLinksSkipCode() {
    let text = parseInlineMarkdown("`<https://x.com|label>` and <https://y.com|y>")
    #expect(String(text.characters) == "<https://x.com|label> and y")
  }
}
