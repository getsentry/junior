import { describe, expect, it } from "vitest";
import { extractContent } from "@/chat/tools/web_fetch/convert";

describe("web fetch content conversion", () => {
  it("converts HTML to markdown with links and headings", () => {
    const html = [
      "<html><body>",
      "<h1>Title</h1>",
      "<p>Hello <a href=\"https://example.com\">world</a>.</p>",
      "<ul><li>One</li><li>Two</li></ul>",
      "</body></html>"
    ].join("");

    const result = extractContent(html, "text/html", 5000);
    expect(result).toContain("# Title");
    expect(result).toContain("[world](https://example.com)");
    expect(result).toContain("- One");
    expect(result).toContain("- Two");
  });

  it("pretty-prints json content", () => {
    const result = extractContent('{"name":"shim","ok":true}', "application/json", 5000);
    expect(result).toContain('"name": "shim"');
    expect(result).toContain('"ok": true');
  });
});
