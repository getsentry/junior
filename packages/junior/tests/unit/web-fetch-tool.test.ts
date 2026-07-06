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
      ok: true,
      status: "success",
      url: safeUrl.toString(),
      content: "hello",
    });

    const tool = createWebFetchTool({});
    const execute = tool.execute!;
    const result = await execute(
      { url: "https://example.com/article", max_chars: 1200 },
      {} as never,
    );

    expect(result).toEqual({
      ok: true,
      status: "success",
      url: safeUrl.toString(),
      content: "hello",
    });
    expect(assertPublicUrlMock).toHaveBeenCalledTimes(1);
    expect(fetchTextWithRedirectsMock).toHaveBeenCalledTimes(1);
    expect(extractWebFetchResponseMock).toHaveBeenCalledTimes(1);
    expect(extractWebFetchResponseMock).toHaveBeenCalledWith(
      safeUrl,
      expect.any(Response),
      1200,
    );
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
      ok: true,
      url: safeUrl.toString(),
      media_type: "image/png",
      images: [
        {
          filename: "logo.png",
          path: "/tmp/junior/artifacts/logo.png",
          attachment_path: "/tmp/junior/artifacts/logo.png",
          media_type: "image/png",
        },
      ],
    });
    expect(JSON.stringify(result)).toContain("sendMessage");
  });

  it("does not recommend sendMessage for fetched images without file-send support", async () => {
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

    expect(JSON.stringify(result)).not.toContain("sendMessage");
    expect(result).toMatchObject({
      ok: true,
      delivery: expect.stringContaining("no file-send tool"),
    });
  });
});
