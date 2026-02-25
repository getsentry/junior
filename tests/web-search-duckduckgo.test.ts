import { describe, expect, it } from "vitest";
import { parseDuckDuckGoHtml } from "@/chat/tools/web_search/duckduckgo";

describe("duckduckgo html parsing", () => {
  it("parses result links/snippets from html SERP output", () => {
    const html = `
      <div class="result results_links results_links_deep web-result result--url-above-snippet">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">Alpha &amp; Beta</a>
          </h2>
          <a class="result__snippet">Example snippet about alpha.</a>
        </div>
      </div>
      <div class="result results_links results_links_deep web-result result--url-above-snippet">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a class="result__a" href="https://example.org/second">Second Result</a>
          </h2>
          <a class="result__snippet">Second snippet.</a>
        </div>
      </div>
    `;

    const parsed = parseDuckDuckGoHtml(html, 5);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      title: "Alpha & Beta",
      url: "https://example.com/alpha",
      snippet: "Example snippet about alpha."
    });
    expect(parsed[1].url).toBe("https://example.org/second");
  });
});
