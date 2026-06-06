import { describe, expect, it } from "vitest";
import {
  extractContent,
  extractContentDetails,
  extractWebFetchResponse,
} from "@/chat/tools/web/fetch-content";

describe("web fetch content conversion", () => {
  it("converts HTML to markdown with links and headings", () => {
    const html = [
      "<html><body>",
      "<h1>Title</h1>",
      '<p>Hello <a href="https://example.com">world</a>.</p>',
      "<ul><li>One</li><li>Two</li></ul>",
      "</body></html>",
    ].join("");

    const result = extractContent(html, "text/html", 5000);
    expect(result).toContain("# Title");
    expect(result).toContain("[world](https://example.com)");
    expect(result).toContain("- One");
    expect(result).toContain("- Two");
  });

  it("pretty-prints json content", () => {
    const result = extractContent(
      '{"name":"junior","ok":true}',
      "application/json",
      5000,
    );
    expect(result).toContain('"name": "junior"');
    expect(result).toContain('"ok": true');
  });

  it("prefers main document content over page chrome", () => {
    const result = extractContentDetails(
      [
        "<html><head><title>Docs &amp; API</title></head><body>",
        "<nav>Skip links Pricing Login</nav>",
        "<main><h1>Streaming agents</h1><p>Use start, append, and stop stream methods.</p></main>",
        "<footer>Copyright and newsletter links</footer>",
        "</body></html>",
      ].join(""),
      "text/html",
      5000,
    );

    expect(result.title).toBe("Docs & API");
    expect(result.content).toContain("# Streaming agents");
    expect(result.content).toContain("start, append, and stop");
    expect(result.content).not.toContain("Pricing Login");
    expect(result.truncated).toBe(false);
  });

  it("does not decode title entities more than once", () => {
    const result = extractContentDetails(
      "<html><head><title>Safe &amp;lt;tag&amp;gt;</title></head><body><main>Body</main></body></html>",
      "text/html",
      5000,
    );

    expect(result.title).toBe("Safe &lt;tag&gt;");
  });

  it("keeps nested article content when extracting main page content", () => {
    const result = extractContentDetails(
      [
        "<html><body>",
        "<article>",
        "<h1>Outer article</h1>",
        "<article><h2>Nested article</h2><p>Nested body.</p></article>",
        "<p>Outer ending.</p>",
        "</article>",
        "<footer>Footer links</footer>",
        "</body></html>",
      ].join(""),
      "text/html",
      5000,
    );

    expect(result.content).toContain("# Outer article");
    expect(result.content).toContain("## Nested article");
    expect(result.content).toContain("Outer ending.");
    expect(result.content).not.toContain("Footer links");
  });

  it("accepts large documentation pages while keeping extracted output bounded", async () => {
    const paragraph = `<p>${"Slack streaming docs ".repeat(800)}</p>`;
    const html = `<html><body>${paragraph.repeat(30)}</body></html>`;

    const result = await extractWebFetchResponse(
      new URL("https://docs.example.com/large"),
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
      1200,
    );

    expect(Buffer.byteLength(html)).toBeGreaterThan(256_000);
    expect(result.content.length).toBeLessThanOrEqual(1203);
    expect(result.content).toContain("Slack streaming docs");
    expect(result.source_bytes).toBe(Buffer.byteLength(html));
    expect(result.extracted_chars).toBeGreaterThan(result.content.length);
    expect(result.truncated).toBe(true);
  });
});
