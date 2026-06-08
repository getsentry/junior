import type { FileUpload } from "chat";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { createWebFetchTool } from "@/chat/tools/web/fetch-tool";
import { mswServer } from "../../msw/server";

const PUBLIC_TEST_ORIGIN = "http://93.184.216.34";

describe("webFetch tool contract", () => {
  it("fetches a public page and returns extracted readable content", async () => {
    mswServer.use(
      http.get(`${PUBLIC_TEST_ORIGIN}/docs`, () =>
        HttpResponse.html(
          [
            "<html><head><title>Agent Docs</title></head><body>",
            "<nav>Pricing Login</nav>",
            "<main><h1>Streaming agents</h1><p>Use deltas for progress.</p></main>",
            "</body></html>",
          ].join(""),
        ),
      ),
    );
    const tool = createWebFetchTool({});

    const result = (await tool.execute?.(
      { url: `${PUBLIC_TEST_ORIGIN}/docs`, max_chars: 1000 },
      {},
    )) as {
      content: string;
      title?: string;
      url: string;
    };

    expect(result).toMatchObject({
      url: `${PUBLIC_TEST_ORIGIN}/docs`,
      title: "Agent Docs",
    });
    expect(result.content).toContain("# Streaming agents");
    expect(result.content).toContain("Use deltas for progress.");
    expect(result.content).not.toContain("Pricing Login");
  });

  it("attaches fetched images through the generated-file outbox", async () => {
    mswServer.use(
      http.get(
        `${PUBLIC_TEST_ORIGIN}/hero.png`,
        () =>
          new HttpResponse(Buffer.from("png-bytes"), {
            headers: { "content-type": "image/png" },
          }),
      ),
    );
    const generatedFiles: FileUpload[] = [];
    const tool = createWebFetchTool({
      onGeneratedFiles(files) {
        generatedFiles.push(...files);
      },
    });

    const result = await tool.execute?.(
      { url: `${PUBLIC_TEST_ORIGIN}/hero.png` },
      {},
    );

    expect(result).toEqual({
      ok: true,
      url: `${PUBLIC_TEST_ORIGIN}/hero.png`,
      media_type: "image/png",
      bytes: Buffer.byteLength("png-bytes"),
      delivery:
        "Fetched image will be attached to the Slack response as a file.",
    });
    expect(generatedFiles).toEqual([
      {
        data: Buffer.from("png-bytes"),
        filename: "hero.png",
        mimeType: "image/png",
      },
    ]);
  });

  it("marks client HTTP failures as non-retryable tool results", async () => {
    mswServer.use(
      http.get(
        `${PUBLIC_TEST_ORIGIN}/missing`,
        () => new HttpResponse("missing", { status: 404 }),
      ),
    );
    const tool = createWebFetchTool({});

    const result = await tool.execute?.(
      { url: `${PUBLIC_TEST_ORIGIN}/missing` },
      {},
    );

    expect(result).toEqual({
      ok: false,
      url: `${PUBLIC_TEST_ORIGIN}/missing`,
      error: "fetch failed: 404",
      status: 404,
      retryable: false,
    });
  });
});
