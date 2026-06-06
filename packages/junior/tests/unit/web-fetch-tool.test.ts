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
      url: safeUrl.toString(),
      content: "hello",
    });

    const tool = createWebFetchTool({});
    const execute = tool.execute!;
    const result = await execute(
      { url: "https://example.com/article", max_chars: 1200 },
      {} as never,
    );

    expect(result).toEqual({ url: safeUrl.toString(), content: "hello" });
    expect(assertPublicUrlMock).toHaveBeenCalledTimes(1);
    expect(fetchTextWithRedirectsMock).toHaveBeenCalledTimes(1);
    expect(extractWebFetchResponseMock).toHaveBeenCalledTimes(1);
    expect(extractWebFetchResponseMock).toHaveBeenCalledWith(
      safeUrl,
      expect.any(Response),
      1200,
    );
  });
});
