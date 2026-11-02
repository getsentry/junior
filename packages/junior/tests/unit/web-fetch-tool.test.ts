import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  assertPublicUrlMock,
  fetchTextWithRedirectsMock,
  withTimeoutMock,
  extractWebFetchResponseMock,
} = vi.hoisted(() => ({
  assertPublicUrlMock: vi.fn(),
  fetchTextWithRedirectsMock: vi.fn(),
  withTimeoutMock: vi.fn(async (task: Promise<unknown>) => task),
  extractWebFetchResponseMock: vi.fn(),
}));

vi.mock("@/chat/tools/web/network", () => ({
  assertPublicUrl: assertPublicUrlMock,
  fetchTextWithRedirects: fetchTextWithRedirectsMock,
  withTimeout: withTimeoutMock,
}));

vi.mock("@/chat/tools/web/fetch-content", () => ({
  extractWebFetchResponse: extractWebFetchResponseMock,
  MAX_FETCH_CHARS: 120000,
}));

import { createWebFetchTool } from "@/chat/tools/web/fetch-tool";

describe("web fetch tool", () => {
  beforeEach(() => {
    assertPublicUrlMock.mockReset();
    fetchTextWithRedirectsMock.mockReset();
    withTimeoutMock.mockClear();
    extractWebFetchResponseMock.mockReset();
  });

  it("uses a single fetch path for non-image responses", async () => {
    const safeUrl = new URL("https://example.com/article");
    assertPublicUrlMock.mockResolvedValue(safeUrl);
    fetchTextWithRedirectsMock.mockResolvedValue(
      new Response("<html><body>hello</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    extractWebFetchResponseMock.mockResolvedValue({
      result: { url: safeUrl.toString(), content: "hello", truncated: false },
      fullContent: "hello",
    });
    const sandbox = { writeFiles: vi.fn() };

    const tool = createWebFetchTool({}, { sandbox });
    const execute = tool.execute!;
    const result = await execute(
      { url: "https://example.com/article", max_chars: 1200 },
      {} as never,
    );

    expect(result).toEqual({
      url: safeUrl.toString(),
      content: "hello",
      truncated: false,
    });
    // A page that fits does not start the sandbox.
    expect(sandbox.writeFiles).not.toHaveBeenCalled();
    expect(assertPublicUrlMock).toHaveBeenCalledTimes(1);
    expect(fetchTextWithRedirectsMock).toHaveBeenCalledTimes(1);
    expect(extractWebFetchResponseMock).toHaveBeenCalledTimes(1);
    expect(extractWebFetchResponseMock).toHaveBeenCalledWith(
      safeUrl,
      expect.any(Response),
      1200,
    );
  });

  it("saves all text of a truncated page to a sandbox file", async () => {
    const safeUrl = new URL("https://docs.example.com/platforms/python/");
    assertPublicUrlMock.mockResolvedValue(safeUrl);
    fetchTextWithRedirectsMock.mockImplementation(
      async () =>
        new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    extractWebFetchResponseMock.mockResolvedValue({
      result: {
        url: safeUrl.toString(),
        content: "start...",
        extracted_chars: 16,
        truncated: true,
      },
      fullContent: "start middle end",
    });
    const sandbox = { writeFiles: vi.fn(async () => {}) };
    const execute = createWebFetchTool({}, { sandbox }).execute!;

    const result = await execute({ url: safeUrl.toString() }, {} as never);

    const path = (result as { full_content_path: string }).full_content_path;
    expect(path).toMatch(
      /\/\.junior\/web-fetch\/docs\.example\.com_platforms_python-[0-9a-f]{8}\.md$/,
    );
    expect(sandbox.writeFiles).toHaveBeenCalledWith([
      { content: "start middle end", path },
    ]);
    expect(result).toMatchObject({
      content: "start...",
      truncated: true,
      full_content_note: expect.stringContaining("untrusted"),
    });

    // A failed write keeps the fetch result and says the text was not saved.
    sandbox.writeFiles.mockRejectedValueOnce(new Error("sandbox unavailable"));
    await expect(
      execute({ url: safeUrl.toString() }, {} as never),
    ).resolves.toEqual({
      url: safeUrl.toString(),
      content: "start...",
      extracted_chars: 16,
      truncated: true,
      full_content_note: expect.stringContaining("not saved"),
    });
  });

  it("writes fetched images to generated artifact paths", async () => {
    const safeUrl = new URL("https://example.com/logo.png");
    assertPublicUrlMock.mockResolvedValue(safeUrl);
    fetchTextWithRedirectsMock.mockResolvedValue(
      new Response(Buffer.from("png-bytes"), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const writeGeneratedArtifacts = vi.fn(async () => [
      {
        bytes: Buffer.from("png-bytes").byteLength,
        filename: "logo.png",
        mimeType: "image/png",
        path: "/tmp/junior/artifacts/logo.png",
      },
    ]);

    const tool = createWebFetchTool(
      { writeGeneratedArtifacts },
      { canSendFilesToActiveConversation: true },
    );
    const execute = tool.execute!;
    const result = await execute(
      { url: "https://example.com/logo.png" },
      {} as never,
    );

    expect(writeGeneratedArtifacts).toHaveBeenCalledWith([
      {
        data: Buffer.from("png-bytes"),
        filename: "logo.png",
        mimeType: "image/png",
      },
    ]);
    expect(result).toMatchObject({
      url: safeUrl.toString(),
      media_type: "image/png",
      images: [
        {
          bytes: Buffer.from("png-bytes").byteLength,
          filename: "logo.png",
          mimeType: "image/png",
          path: "/tmp/junior/artifacts/logo.png",
        },
      ],
    });
    expect(JSON.stringify(result)).toContain("sendFiles");
  });

  it("does not recommend sendFiles for fetched images without file-send support", async () => {
    const safeUrl = new URL("https://example.com/local.png");
    assertPublicUrlMock.mockResolvedValue(safeUrl);
    fetchTextWithRedirectsMock.mockResolvedValue(
      new Response(Buffer.from("png-bytes"), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const writeGeneratedArtifacts = vi.fn(async () => [
      {
        bytes: Buffer.from("png-bytes").byteLength,
        filename: "local.png",
        mimeType: "image/png",
        path: "/tmp/junior/artifacts/local.png",
      },
    ]);

    const tool = createWebFetchTool({ writeGeneratedArtifacts });
    const execute = tool.execute!;
    const result = await execute(
      { url: "https://example.com/local.png" },
      {} as never,
    );

    expect(JSON.stringify(result)).not.toContain("sendFiles");
    expect(result).toMatchObject({
      delivery: expect.stringContaining("no file-send tool"),
    });
  });
});
