import { describe, expect, it, vi } from "vitest";
import { FETCH_TIMEOUT_MS, MAX_FETCH_BYTES } from "@/chat/tools/web/constants";
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

    const result = extractContent(html, "text/html");
    expect(result).toContain("# Title");
    expect(result).toContain("[world](https://example.com)");
    expect(result).toContain("- One");
    expect(result).toContain("- Two");
  });

  it("pretty-prints json content", () => {
    const result = extractContent(
      '{"name":"junior","ok":true}',
      "application/json",
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
    );

    expect(result.title).toBe("Docs & API");
    expect(result.content).toContain("# Streaming agents");
    expect(result.content).toContain("start, append, and stop");
    expect(result.content).not.toContain("Pricing Login");
  });

  it("does not decode title entities more than once", () => {
    const result = extractContentDetails(
      "<html><head><title>Safe &amp;lt;tag&amp;gt;</title></head><body><main>Body</main></body></html>",
      "text/html",
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
    );

    expect(result.content).toContain("# Outer article");
    expect(result.content).toContain("## Nested article");
    expect(result.content).toContain("Outer ending.");
    expect(result.content).not.toContain("Footer links");
  });

  it("keeps all extracted text of a large page", async () => {
    const paragraph = `<p>${"Slack streaming docs ".repeat(800)}</p>`;
    const html = `<html><body>${paragraph.repeat(30)}</body></html>`;

    const result = await extractWebFetchResponse(
      new URL("https://docs.example.com/large"),
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    expect(Buffer.byteLength(html)).toBeGreaterThan(256_000);
    // The tool pipeline cuts long content for the model, not the tool.
    expect(result.content.length).toBeGreaterThan(400_000);
    expect(result.source_bytes).toBe(Buffer.byteLength(html));
    expect(result.truncated).toBe(false);
  });

  it("keeps the first part of a page over the byte limit", async () => {
    const paragraph = `<p>${"Slack streaming docs ".repeat(800)}</p>`;
    const html = `<html><body><main>${paragraph.repeat(80)}</main></body></html>`;

    const result = await extractWebFetchResponse(
      new URL("https://docs.example.com/huge"),
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    expect(Buffer.byteLength(html)).toBeGreaterThan(MAX_FETCH_BYTES);
    expect(result.content).toContain("Slack streaming docs");
    expect(result.source_bytes).toBe(MAX_FETCH_BYTES);
    expect(result.truncated).toBe(true);
  });

  it("cancels a body that stalls past the read timeout", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<html><body>"));
        },
        cancel,
      });

      const read = extractWebFetchResponse(
        new URL("https://docs.example.com/stalled"),
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);

      expect(await read).toMatchObject({ message: "read timed out" });
      expect(cancel).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports client-side fetch failures as repairable tool errors", async () => {
    await expect(
      extractWebFetchResponse(
        new URL("https://docs.example.com/missing"),
        new Response("missing", { status: 404 }),
      ),
    ).rejects.toMatchObject({
      message: "fetch failed: 404",
      name: "ToolInputError",
    });
  });

  it("reports upstream fetch failures as runtime errors", async () => {
    await expect(
      extractWebFetchResponse(
        new URL("https://docs.example.com/broken"),
        new Response("boom", { status: 500 }),
      ),
    ).rejects.toMatchObject({
      message: "fetch failed: 500",
      name: "Error",
    });
  });
});
